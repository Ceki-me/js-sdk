/**
 * Browser WebSocket adapter — mimics the `ws` package API surface that
 * src/client.ts uses, backed by the native globalThis.WebSocket.
 *
 * The SDK only calls `.on('open'|'message'|'close'|'error')`, `.send()`,
 * `.close()`, `readyState`, `OPEN`, `.terminate()`. Native WebSocket differs:
 * event properties (onopen/onmessage/...), string message (not Buffer),
 * no terminate(). This adapter bridges those few differences so the rest of
 * the SDK runs unchanged in the browser.
 *
 * @internal — used via tsup alias (`ws` → this file) in the browser build.
 */

export interface WsLike {
  readyState: number;
  readonly OPEN: number;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number, reason: string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export class BrowserWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly OPEN = BrowserWebSocket.OPEN;

  readyState!: number;
  url = '';
  binaryType = 'blob' as BinaryType;
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  addEventListener(): void { throw new Error('BrowserWebSocket.addEventListener not implemented'); }
  removeEventListener(): void { throw new Error('BrowserWebSocket.removeEventListener not implemented'); }
  dispatchEvent(): boolean { throw new Error('BrowserWebSocket.dispatchEvent not implemented'); }
  ping(): void { throw new Error('BrowserWebSocket.ping — ws-package method, unused by SDK'); }
  pause(): void {}
  resume(): void {}
  setMaxListeners(): void {}
  once(): this { return this; }
  emit(): boolean { return false; }

  private _onOpen: (() => void) | null = null;
  private _onMessage: ((data: unknown) => void) | null = null;
  private _onClose: ((code: number, reason: string) => void) | null = null;
  private _onError: ((err: Error) => void) | null = null;

  private _ws: globalThis.WebSocket;

  constructor(url: string, protocols?: string | string[]) {
    this._ws = new globalThis.WebSocket(url, protocols as string | string[]);
    this.readyState = this._ws.readyState;

    this._ws.onopen = () => {
      this.readyState = this._ws.readyState;
      this._onOpen?.();
    };
    this._ws.onmessage = (ev: MessageEvent) => {
      const data: string = typeof ev.data === 'string'
        ? ev.data
        : ev.data instanceof Blob
          ? ''
          : String(ev.data);
      this._onMessage?.(data);
    };
    this._ws.onclose = (ev: CloseEvent) => {
      this.readyState = this._ws.readyState;
      this._onClose?.(ev.code, ev.reason ?? '');
    };
    this._ws.onerror = () => {
      this._onError?.(new Error('WebSocket error'));
    };
  }

  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number, reason: string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: unknown): void {
    switch (event) {
      case 'open': this._onOpen = cb as () => void; break;
      case 'message': this._onMessage = cb as (d: unknown) => void; break;
      case 'close': this._onClose = cb as (c: number, r: string) => void; break;
      case 'error': this._onError = cb as (e: Error) => void; break;
      default: throw new Error(`BrowserWebSocket: unsupported event '${event}'`);
    }
  }

  send(data: unknown): void {
    // Blob not used by the SDK; string / ArrayBuffer / Buffer(path) pass through.
    this._ws.send(data as string | ArrayBuffer | ArrayBufferView);
  }

  close(code?: number, reason?: string): void {
    this._ws.close(code, reason);
  }

  /** ws-package escape hatch — hard-kill the connection. */
  terminate(): void {
    try { this._ws.close(); } catch { /* already closed */ }
  }
}

export const WebSocket = BrowserWebSocket;
export default WebSocket;
export type WebSocketLike = WsLike;
