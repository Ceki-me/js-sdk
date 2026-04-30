import { CekiBrowserError, CommandTimeout } from './errors.js';

interface PendingCmd {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type SignalingCallback = (method: string, params: Record<string, unknown>) => void;

export class RTCTransport {
  pc: RTCPeerConnection;
  cmdChannel: RTCDataChannel;

  private _cmdPending = new Map<number, PendingCmd>();
  private _cmdNextId = 1;
  private _signalingCallback: SignalingCallback | null = null;
  private _connectedResolve: (() => void) | null = null;
  private _connectedReject: ((err: Error) => void) | null = null;
  private _connectedPromise: Promise<void>;
  private _closed = false;

  constructor(iceServers: RTCIceServer[]) {
    this._connectedPromise = new Promise((resolve, reject) => {
      this._connectedResolve = resolve;
      this._connectedReject = reject;
    });

    this.pc = new RTCPeerConnection({ iceServers });
    this.cmdChannel = this.pc.createDataChannel('ceki-cmd', { ordered: true });

    this._setupCmdChannel(this.cmdChannel);

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate && this._signalingCallback) {
        this._signalingCallback('webrtc.ice', {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this._connectedResolve?.();
        this._signalingCallback?.('webrtc.connected', {});
      } else if (state === 'failed' || state === 'closed') {
        this._connectedReject?.(new CekiBrowserError(`WebRTC connection ${state}`));
      }
    };
  }

  onSignaling(callback: SignalingCallback): void {
    this._signalingCallback = callback;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._gatherICE();
    return this.pc.localDescription!;
  }

  async applyAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!candidate.candidate) return;
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async waitConnected(timeoutMs = 30000): Promise<void> {
    const timer = setTimeout(() => {
      this._connectedReject?.(new CekiBrowserError('WebRTC connection timed out'));
    }, timeoutMs);
    try {
      await this._connectedPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendCommand(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (this.cmdChannel.readyState !== 'open') {
      throw new CekiBrowserError('Command DataChannel not open');
    }

    const id = this._cmdNextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._cmdPending.delete(id);
        reject(new CommandTimeout(`Command ${method} timed out after ${timeoutMs}ms`, -1020));
      }, timeoutMs);

      this._cmdPending.set(id, { resolve, reject, timer });

      const payload: Record<string, unknown> = { jsonrpc: '2.0', method, id };
      if (params) payload.params = params;
      this.cmdChannel.send(JSON.stringify(payload));
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const [, pending] of this._cmdPending) {
      clearTimeout(pending.timer);
      pending.reject(new CekiBrowserError('Transport closed'));
    }
    this._cmdPending.clear();
    this.pc.close();
  }

  private _setupCmdChannel(ch: RTCDataChannel): void {
    ch.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      const id = msg.id as number | undefined;
      if (id != null && this._cmdPending.has(id)) {
        const pending = this._cmdPending.get(id)!;
        this._cmdPending.delete(id);
        clearTimeout(pending.timer);

        if (msg.error) {
          const err = msg.error as { code?: number; message?: string };
          pending.reject(new CekiBrowserError(err.message ?? 'Unknown error', err.code ?? 0));
        } else {
          pending.resolve(msg.result);
        }
      }
    };
  }

  private _gatherICE(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          resolve();
        }
      };
      this.pc.onicegatheringstatechange = check;
      setTimeout(resolve, 10000);
    });
  }
}
