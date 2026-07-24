/**
 * WebRTC transport for P2P CDP communication.
 *
 * Wraps RTCPeerConnection to provide a WebRTC DataChannel-based
 * transport for CDP commands. Used as primary transport for agent-renters,
 * with WebSocket as fallback.
 *
 * Protocol (mirrors front useWebRTCP2P.js):
 * 1. After ``match`` -> create RTCPeerConnection + DataChannel('ceki-cmd')
 * 2. createOffer -> setLocalDescription -> extract DTLS fingerprint -> send
 *    ``webrtc.offer {session_id, sdp, fingerprint}`` via WS signaling
 * 3. Receive ``webrtc.answer`` -> setRemoteDescription -> ICE exchange
 * 4. ICE candidates: local -> ``webrtc.ice_candidate`` via WS;
 *    remote -> addIceCandidate
 * 5. ``ceki-cmd`` DC open -> CDP JSON commands sent over DC instead of WS
 * 6. Inbound CDP responses/events arrive on DC -> forwarded to callback
 */
import wrtc from '@roamhq/wrtc';
const {
  RTCPeerConnection,
  RTCDataChannel,
  RTCDataChannelEvent,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCPeerConnectionIceEvent,
} = wrtc;

// SDP fingerprint extraction regex (mirrors front extractFingerprint)
const FINGERPRINT_RE = /a=fingerprint:(sha-\d+) (\S+)/i;

export interface WebRTCConfig {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * WebRTC peer connection wrapper for P2P CDP transport.
 *
 * This is the js-sdk counterpart of the browser extension's
 * ``RtcBridge`` / ``RtcPeer`` classes. It manages one
 * ``RTCPeerConnection`` with a single ``ceki-cmd`` data channel
 * for CDP command/response exchange.
 *
 * Usage::
 *
 *   const transport = new WebRTCTransport({ iceServers: [...] });
 *   transport.onIceCandidate = (candidate) => wsSend(...);
 *   transport.onCdpMessage = (msg) => handleCdp(msg);
 *
 *   const offer = await transport.createOffer();
 *   const fingerprint = transport.localFingerprint;
 *   // send webrtc.offer {session_id, sdp, fingerprint} via WS
 *
 *   // on webrtc.answer:
 *   await transport.setRemoteDescription(answerSdp);
 *
 *   // on webrtc.ice_candidate:
 *   await transport.addIceCandidate(candidate);
 */
export class WebRTCTransport {
  private _pc: RTCPeerConnection | null = null;
  private _cmdDc: RTCDataChannel | null = null;
  private _localFingerprint: string | null = null;
  private _pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private _closed = false;
  private _iceServers: RTCIceServer[];
  private _iceTransportPolicy: 'all' | 'relay';

  // Callbacks — set by consumer (client.ts)
  onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null;
  onCdpMessage: ((msg: Record<string, unknown>) => void) | null = null;
  onConnectionState: ((state: string) => void) | null = null;
  onDataChannelState: ((state: string) => void) | null = null;

  // DC open promise — used by Browser.send() to wait for DC readiness
  private _dcOpenResolve: (() => void) | null = null;
  private _dcOpenPromise!: Promise<void>;

  constructor(config?: WebRTCConfig) {
    // ICE servers: constructor arg -> CEKI_TURN_SERVERS env -> default STUN
    const envServersRaw = typeof process !== 'undefined' ? process.env.CEKI_TURN_SERVERS : undefined;
    const envServers: RTCIceServer[] = [];
    if (envServersRaw) {
      try {
        const parsed = JSON.parse(envServersRaw);
        if (Array.isArray(parsed)) {
          envServers.push(...parsed);
        }
      } catch {
        // Silently ignore invalid JSON
      }
    }

    const merged: RTCIceServer[] = config?.iceServers ? [...config.iceServers] : [];
    const seenUrls = new Set<string>();
    for (const srv of merged) {
      const urls = srv.urls;
      if (typeof urls === 'string') {
        seenUrls.add(urls);
      } else if (Array.isArray(urls)) {
        urls.forEach(u => seenUrls.add(u));
      }
    }
    for (const srv of envServers) {
      const urls = srv.urls;
      if (typeof urls === 'string') {
        if (!seenUrls.has(urls)) {
          merged.push(srv);
          seenUrls.add(urls);
        }
      } else if (Array.isArray(urls)) {
        const newUrls = urls.filter(u => !seenUrls.has(u));
        if (newUrls.length > 0) {
          merged.push({ ...srv, urls: newUrls });
          newUrls.forEach(u => seenUrls.add(u));
        }
      }
    }

    this._iceServers = merged.length > 0
      ? merged
      : [{ urls: 'stun:stun.l.google.com:19302' }];

    // ICE transport policy: constructor arg -> CEKI_ICE_TRANSPORT_POLICY env -> "all"
    const envPolicy = typeof process !== 'undefined' ? process.env.CEKI_ICE_TRANSPORT_POLICY : undefined;
    this._iceTransportPolicy = config?.iceTransportPolicy
      ?? (envPolicy === 'relay' ? 'relay' as const : 'all');

    this._resetDcOpen();
  }

  private _resetDcOpen(): void {
    this._dcOpenPromise = new Promise<void>((resolve) => {
      this._dcOpenResolve = resolve;
    });
  }

  private async _ensurePc(): Promise<RTCPeerConnection> {
    if (this._pc !== null) {
      return this._pc;
    }

    const config: RTCConfiguration = {
      iceServers: this._iceServers,
    };
    if (this._iceTransportPolicy === 'relay') {
      config.iceTransportPolicy = 'relay';
    }

    this._pc = new RTCPeerConnection(config);

    // Wire ICE candidate callback
    this._pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
      const candidate = event.candidate;
      if (!candidate) {
        // ICE gathering complete
        return;
      }
      if (this.onIceCandidate) {
        this.onIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }
    });

    // Wire connection state
    this._pc.addEventListener('connectionstatechange', () => {
      const state = this._pc?.connectionState ?? 'closed';
      if (this.onConnectionState) {
        this.onConnectionState(state);
      }
    });

    // Handle incoming data channels (host-side — provider creates capture DC)
    this._pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      const channel = event.channel;
      if (channel.label === 'ceki-cmd') {
        this._cmdDc = channel;
        this._wireCmdDc(channel);
      } else if (channel.label === 'ceki-capture') {
        // Agent doesn't process capture frames, but log it
        // (no-op for agent)
      }
    });

    return this._pc;
  }

  private _wireCmdDc(channel: RTCDataChannel): void {
    channel.addEventListener('open', () => {
      this._dcOpenResolve?.();
      if (this.onDataChannelState) {
        this.onDataChannelState('open');
      }
    });

    channel.addEventListener('close', () => {
      if (this.onDataChannelState) {
        this.onDataChannelState('closed');
      }
    });

    channel.addEventListener('message', (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (this.onCdpMessage) {
        this.onCdpMessage(data);
      }
    });
  }

  /**
   * Create and set local offer, return the SDP string.
   *
   * Also creates the ``ceki-cmd`` data channel before generating the offer
   * so the SDP includes it (mirrors front setupCmdChannel).
   */
  async createOffer(): Promise<string> {
    const pc = await this._ensurePc();

    // Reset DC-open promise for the new connection
    this._resetDcOpen();

    // Create ceki-cmd data channel (renter->host CDP commands)
    this._cmdDc = pc.createDataChannel('ceki-cmd', { ordered: true });
    this._wireCmdDc(this._cmdDc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._cacheFingerprint(pc.localDescription!.sdp);
    return pc.localDescription!.sdp;
  }

  /**
   * Set remote offer, create and set local answer, return answer SDP.
   */
  async createAnswer(remoteSdp: string): Promise<string> {
    const pc = await this._ensurePc();
    const remoteDesc = new RTCSessionDescription({ sdp: remoteSdp, type: 'offer' });
    await pc.setRemoteDescription(remoteDesc);

    // Flush pending ICE candidates (queued before remote was set)
    const pending = this._pendingRemoteCandidates;
    this._pendingRemoteCandidates = [];
    for (const cand of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {
        // Silently skip invalid candidates
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._cacheFingerprint(pc.localDescription!.sdp);
    return pc.localDescription!.sdp;
  }

  /**
   * Set remote description (answer from host).
   */
  async setRemoteDescription(sdp: string, type: 'offer' | 'answer' = 'answer'): Promise<void> {
    const pc = await this._ensurePc();
    const remoteDesc = new RTCSessionDescription({ sdp, type });
    await pc.setRemoteDescription(remoteDesc);

    // Flush pending ICE candidates
    const pending = this._pendingRemoteCandidates;
    this._pendingRemoteCandidates = [];
    for (const cand of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {
        // Silently skip invalid candidates
      }
    }
  }

  /**
   * Add a remote ICE candidate.
   *
   * Queues the candidate if remote description hasn't been set yet
   * (mirrors front pendingCandidates pattern).
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this._pc;
    if (pc === null || pc.remoteDescription === null) {
      this._pendingRemoteCandidates.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Silently skip invalid candidates
    }
  }

  /**
   * Return cached DTLS fingerprint from local SDP.
   *
   * The fingerprint is extracted from the local SDP after
   * ``setLocalDescription`` and cached. It is sent as part of
   * the ``webrtc.offer`` / ``webrtc.ice_candidate`` signaling
   * messages (mirrors front extractFingerprint).
   */
  get localFingerprint(): string | null {
    return this._localFingerprint;
  }

  /**
   * Update the ICE server list for future use.
   *
   * If the RTCPeerConnection has not been created yet (``_ensurePc``
   * not called), the new servers will be used when it is first created.
   * If the PC already exists, the servers are stored for potential
   * future reconnection.
   *
   * De-duplicates by ``urls`` field against existing servers.
   */
  setIceServers(iceServers: RTCIceServer[]): void {
    const seenUrls = new Set<string>();
    for (const srv of this._iceServers) {
      const urls = srv.urls;
      if (typeof urls === 'string') {
        seenUrls.add(urls);
      } else if (Array.isArray(urls)) {
        urls.forEach(u => seenUrls.add(u));
      }
    }
    for (const srv of iceServers) {
      const urls = srv.urls;
      if (typeof urls === 'string') {
        if (!seenUrls.has(urls)) {
          this._iceServers.push(srv);
          seenUrls.add(urls);
        }
      } else if (Array.isArray(urls)) {
        const newUrls = urls.filter(u => !seenUrls.has(u));
        if (newUrls.length > 0) {
          this._iceServers.push({ ...srv, urls: newUrls });
          newUrls.forEach(u => seenUrls.add(u));
        }
      }
    }
  }

  /**
   * Set ICE transport policy for future use (``"all"`` or ``"relay"``).
   *
   * Like ``setIceServers``, only applies to a new PC if ``_ensurePc``
   * has not been called yet.
   */
  setIceTransportPolicy(policy: 'all' | 'relay'): void {
    if (policy !== 'all' && policy !== 'relay') {
      throw new Error(`ICE transport policy must be 'all' or 'relay', got ${policy}`);
    }
    this._iceTransportPolicy = policy;
  }

  /**
   * Send a CDP message over the ceki-cmd data channel.
   *
   * Throws ``ConnectionLost`` if the data channel is not open.
   */
  async sendCdp(msg: Record<string, unknown>): Promise<void> {
    if (this._cmdDc === null || this._cmdDc.readyState !== 'open') {
      throw new Error('ceki-cmd DC not open');
    }
    this._cmdDc.send(JSON.stringify(msg));
  }

  /**
   * Wait for the ceki-cmd data channel to open.
   *
   * Used by ``Browser.send()`` to prevent CDP from being sent over WS
   * before P2P DC is ready (startup-race guard). The caller wraps this
   * with a timeout for timeout handling.
   */
  async waitForDcOpen(): Promise<void> {
    await this._dcOpenPromise;
  }

  /** Whether the P2P connection is established. */
  get isConnected(): boolean {
    if (this._pc === null) return false;
    return this._pc.connectionState === 'connected';
  }

  /** Whether the ceki-cmd data channel is open. */
  get cmdDcOpen(): boolean {
    if (this._cmdDc === null) return false;
    return this._cmdDc.readyState === 'open';
  }

  /** Close the peer connection and cleanup. */
  async close(): Promise<void> {
    this._closed = true;
    if (this._cmdDc !== null) {
      try {
        this._cmdDc.close();
      } catch {
        // Best-effort
      }
      this._cmdDc = null;
    }
    if (this._pc !== null) {
      try {
        this._pc.close();
      } catch {
        // Best-effort
      }
      this._pc = null;
    }
    this._resetDcOpen();
    this._localFingerprint = null;
    this._pendingRemoteCandidates = [];
  }

  private _cacheFingerprint(sdp: string): void {
    const match = FINGERPRINT_RE.exec(sdp);
    if (match) {
      this._localFingerprint = match[2];
    } else {
      this._localFingerprint = null;
    }
  }
}
