import WebSocket from 'ws';
import {
  AuthError,
  CekiBrowserError,
  CommandTimeout,
  ERROR_CODE_MAP,
} from './errors.js';
import type { JsonRpcMessage } from './types.js';

export const DEFAULT_RELAY_URL = 'wss://browser.ceki.me/ws/agent';

export type EventCallback = (method: string, params: Record<string, unknown>) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Transport {
  private _token: string;
  private _relayUrl: string;
  private _ws: WebSocket | null = null;
  private _pending = new Map<number | string, PendingRequest>();
  private _nextId = 1;
  private _eventCallback: EventCallback | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _agentId: string | null = null;
  private _closed = false;

  constructor(token: string, relayUrl: string = DEFAULT_RELAY_URL) {
    this._token = token;
    this._relayUrl = relayUrl;
  }

  get agentId(): string | null {
    return this._agentId;
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  onEvent(callback: EventCallback): void {
    this._eventCallback = callback;
  }

  async connect(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._relayUrl, {
        headers: { Authorization: `Bearer ${this._token}` },
      });

      let welcomed = false;

      ws.on('open', () => {
        this._ws = ws;
      });

      ws.on('message', (data: Buffer | string) => {
        const msg: JsonRpcMessage = JSON.parse(data.toString());

        if (!welcomed) {
          welcomed = true;
          if (msg.error) {
            reject(new AuthError(msg.error.message, msg.error.code));
            ws.close();
            return;
          }
          const result = (msg.result ?? {}) as Record<string, unknown>;
          this._agentId = result.agent_id as string ?? null;
          this._startHeartbeat();
          resolve(result);
          return;
        }

        this._handleMessage(msg);
      });

      ws.on('error', (err) => {
        if (!welcomed) {
          reject(new AuthError(`Failed to connect: ${err.message}`));
        }
      });

      ws.on('close', () => {
        this._stopHeartbeat();
        for (const [, pending] of this._pending) {
          clearTimeout(pending.timer);
          pending.reject(new CekiBrowserError('Connection lost'));
        }
        this._pending.clear();
        this._ws = null;
      });
    });
  }

  async close(): Promise<void> {
    this._closed = true;
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new CekiBrowserError('Transport closed'));
    }
    this._pending.clear();
  }

  send(method: string, params?: Record<string, unknown>, timeout = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new CekiBrowserError('Not connected'));
        return;
      }

      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CommandTimeout(`Command ${method} timed out after ${timeout}ms`, -1020));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });

      const payload: JsonRpcMessage = { jsonrpc: '2.0', method, id };
      if (params) payload.params = params;
      this._ws.send(JSON.stringify(payload));
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const payload: JsonRpcMessage = { jsonrpc: '2.0', method };
    if (params) payload.params = params;
    this._ws.send(JSON.stringify(payload));
  }

  private _handleMessage(msg: JsonRpcMessage): void {
    const id = msg.id;

    if (id != null && this._pending.has(id as number)) {
      const pending = this._pending.get(id as number)!;
      this._pending.delete(id as number);
      clearTimeout(pending.timer);

      if (msg.error) {
        const code = msg.error.code;
        const Cls = ERROR_CODE_MAP[code] ?? CekiBrowserError;
        pending.reject(new Cls(msg.error.message, code));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method && this._eventCallback) {
      this._eventCallback(msg.method, msg.params ?? {});
    }
  }

  private _startHeartbeat(): void {
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && !this._closed) {
        this.send('heartbeat', undefined, 5000).catch(() => {});
      }
    }, 10000);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}
