import { randomUUID } from 'crypto';
import { CekiBrowserError, CommandTimeout } from './errors.js';

const CHUNK_SIZE = 12 * 1024;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_HISTORY = 200;
const MAX_IMAGE_MEMORY = 50 * 1024 * 1024;
const ASSEMBLER_TIMEOUT_MS = 30_000;

export interface ChatTextMessage {
  id: string;
  from: 'agent' | 'provider';
  ts: number;
  text: string;
}

export interface ChatImage {
  id: string;
  from: 'agent' | 'provider';
  ts: number;
  mime: string;
  data: Uint8Array;
  previewB64?: string;
}

interface ImageAssembler {
  id: string;
  from: string;
  ts: number;
  mime: string;
  sizeBytes: number;
  totalChunks: number;
  previewB64: string;
  chunks: (string | null)[];
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCmd {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type SignalingCallback = (method: string, params: Record<string, unknown>) => void;

export class RTCTransport {
  pc: RTCPeerConnection;
  cmdChannel: RTCDataChannel;
  chatChannel: RTCDataChannel;

  private _cmdPending = new Map<number, PendingCmd>();
  private _cmdNextId = 1;
  private _chatTextHandlers: Array<(msg: ChatTextMessage) => void> = [];
  private _chatImageHandlers: Array<(img: ChatImage) => void> = [];
  private _signalingCallback: SignalingCallback | null = null;
  private _connectedResolve: (() => void) | null = null;
  private _connectedReject: ((err: Error) => void) | null = null;
  private _connectedPromise: Promise<void>;
  private _closed = false;

  private _chatHistory: Array<ChatTextMessage | ChatImage> = [];
  private _assemblers = new Map<string, ImageAssembler>();
  private _totalImageBytes = 0;

  constructor(iceServers: RTCIceServer[]) {
    this._connectedPromise = new Promise((resolve, reject) => {
      this._connectedResolve = resolve;
      this._connectedReject = reject;
    });

    this.pc = new RTCPeerConnection({ iceServers });
    this.cmdChannel = this.pc.createDataChannel('ceki-cmd', { ordered: true });
    this.chatChannel = this.pc.createDataChannel('ceki-chat', { ordered: true });

    this._setupCmdChannel(this.cmdChannel);
    this._setupChatChannel(this.chatChannel);

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

  onChatMessage(callback: (msg: ChatTextMessage) => void): void {
    this._chatTextHandlers.push(callback);
  }

  onChatImage(callback: (img: ChatImage) => void): void {
    this._chatImageHandlers.push(callback);
  }

  get chatHistory(): Array<ChatTextMessage | ChatImage> {
    return [...this._chatHistory];
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

  sendChatText(text: string): void {
    if (this.chatChannel.readyState !== 'open') {
      throw new CekiBrowserError('Chat DataChannel not open');
    }

    const msg = {
      type: 'msg',
      id: randomUUID(),
      from: 'agent',
      ts: Date.now(),
      text,
    };
    this.chatChannel.send(JSON.stringify(msg));
    this._addToHistory({ id: msg.id, from: 'agent', ts: msg.ts, text } as ChatTextMessage);
  }

  async sendChatImage(data: Uint8Array | ArrayBuffer | string, mime = 'image/png'): Promise<void> {
    if (this.chatChannel.readyState !== 'open') {
      throw new CekiBrowserError('Chat DataChannel not open');
    }

    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }

    if (bytes.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large (${bytes.length} bytes > ${MAX_IMAGE_SIZE}). Downscale before sending.`);
    }

    let b64 = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    b64 = btoa(b64);

    const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);
    const id = randomUUID();
    const ts = Date.now();

    this.chatChannel.send(JSON.stringify({
      type: 'img-start',
      id,
      from: 'agent',
      ts,
      mime,
      size_bytes: bytes.length,
      total_chunks: totalChunks,
    }));

    for (let i = 0; i < totalChunks; i++) {
      const chunk = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      this.chatChannel.send(JSON.stringify({
        type: 'img-chunk',
        id,
        seq: i,
        data: chunk,
      }));
    }

    this.chatChannel.send(JSON.stringify({ type: 'img-end', id }));

    this._enforceMemoryCap(bytes.length);
    this._totalImageBytes += bytes.length;
    this._addToHistory({ id, from: 'agent', ts, mime, data: bytes } as ChatImage);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const asm of this._assemblers.values()) clearTimeout(asm.timer);
    this._assemblers.clear();
    for (const [, pending] of this._cmdPending) {
      clearTimeout(pending.timer);
      pending.reject(new CekiBrowserError('Transport closed'));
    }
    this._cmdPending.clear();
    this._chatHistory.length = 0;
    this._totalImageBytes = 0;
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

  private _setupChatChannel(ch: RTCDataChannel): void {
    ch.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'msg':
          this._handleChatText(msg);
          break;
        case 'img-start':
          this._handleImgStart(msg);
          break;
        case 'img-chunk':
          this._handleImgChunk(msg);
          break;
        case 'img-end':
          this._handleImgEnd(msg);
          break;
      }
    };
  }

  private _handleChatText(msg: Record<string, unknown>): void {
    const cm: ChatTextMessage = {
      id: (msg.id as string) ?? '',
      from: (msg.from as 'agent' | 'provider') ?? 'provider',
      ts: (msg.ts as number) ?? 0,
      text: (msg.text as string) ?? '',
    };
    this._addToHistory(cm);
    for (const h of this._chatTextHandlers) {
      try { h(cm); } catch { /* */ }
    }
  }

  private _handleImgStart(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    if (this._assemblers.has(id)) return;
    const total = msg.total_chunks as number;
    const timer = setTimeout(() => this._assemblerTimeout(id), ASSEMBLER_TIMEOUT_MS);
    this._assemblers.set(id, {
      id,
      from: (msg.from as string) ?? 'provider',
      ts: (msg.ts as number) ?? 0,
      mime: (msg.mime as string) ?? 'image/png',
      sizeBytes: (msg.size_bytes as number) ?? 0,
      totalChunks: total,
      previewB64: (msg.preview_b64 as string) ?? '',
      chunks: new Array(total).fill(null),
      received: 0,
      timer,
    });
  }

  private _handleImgChunk(msg: Record<string, unknown>): void {
    const asm = this._assemblers.get(msg.id as string);
    if (!asm) return;
    const seq = msg.seq as number;
    if (seq >= 0 && seq < asm.chunks.length && asm.chunks[seq] === null) {
      asm.chunks[seq] = msg.data as string;
      asm.received++;
    }
  }

  private _handleImgEnd(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const asm = this._assemblers.get(id);
    if (!asm) return;
    clearTimeout(asm.timer);
    this._assemblers.delete(id);

    const b64 = asm.chunks.join('');
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return;
    }

    this._enforceMemoryCap(bytes.length);
    this._totalImageBytes += bytes.length;

    const img: ChatImage = {
      id: asm.id,
      from: asm.from as 'agent' | 'provider',
      ts: asm.ts,
      mime: asm.mime,
      data: bytes,
      previewB64: asm.previewB64 || undefined,
    };
    this._addToHistory(img);
    for (const h of this._chatImageHandlers) {
      try { h(img); } catch { /* */ }
    }
  }

  private _assemblerTimeout(id: string): void {
    const asm = this._assemblers.get(id);
    if (asm) {
      this._assemblers.delete(id);
    }
  }

  private _addToHistory(item: ChatTextMessage | ChatImage): void {
    this._chatHistory.push(item);
    if (this._chatHistory.length > MAX_HISTORY) {
      const removed = this._chatHistory.shift()!;
      if ('data' in removed && removed.data instanceof Uint8Array) {
        this._totalImageBytes -= removed.data.length;
      }
    }
  }

  private _enforceMemoryCap(incoming: number): void {
    while (this._totalImageBytes + incoming > MAX_IMAGE_MEMORY && this._chatHistory.length > 0) {
      const idx = this._chatHistory.findIndex((m) => 'data' in m && m.data instanceof Uint8Array);
      if (idx === -1) break;
      const removed = this._chatHistory.splice(idx, 1)[0];
      if ('data' in removed && removed.data instanceof Uint8Array) {
        this._totalImageBytes -= removed.data.length;
      }
    }
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
