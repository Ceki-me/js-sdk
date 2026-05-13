import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TimeoutError, ChatSendFailed } from './errors.js';
import type { ChatMessage, ReadReceipt, ChatHistoryOptions } from './types.js';
import type { Browser } from './browser.js';

type MessageHandler = (msg: ChatMessage) => void | Promise<void>;
type ReadHandler = (receipt: ReadReceipt) => void | Promise<void>;

interface PendingSend {
  resolve: (value: { messageId: string; sentAt: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

function detectMime(buf: Buffer): { mime: string; ext: string } {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return { mime: 'application/octet-stream', ext: 'bin' };
}

function randomHex(len: number): string {
  return crypto.randomBytes(len / 2).toString('hex');
}

export class BrowserChat {
  private _browser: Browser;
  private _topicId: string | null;
  private _messageHandlers: MessageHandler[] = [];
  private _readHandlers: ReadHandler[] = [];
  private _pendingSends: Map<string, PendingSend> = new Map();

  constructor(browser: Browser) {
    this._browser = browser;
    this._topicId = browser.chatTopicId;
  }

  get topicId(): string | null {
    return this._topicId;
  }

  async send(text: string): Promise<{ messageId: string; sentAt: string }> {
    const clientMsgId = randomHex(32);
    const msg = {
      type: 'chat.send' as const,
      session_id: this._browser.sessionId,
      client_msg_id: clientMsgId,
      text,
    };

    return new Promise<{ messageId: string; sentAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingSends.delete(clientMsgId);
        reject(new TimeoutError('Chat send timed out'));
      }, 15000);
      this._pendingSends.set(clientMsgId, { resolve, reject, timer });
      this._browser._sendRaw(msg);
    });
  }

  async sendImage(source: string | Buffer, text?: string): Promise<{ messageId: string; sentAt: string }> {
    let buf: Buffer;
    let filename: string;

    if (typeof source === 'string') {
      buf = fs.readFileSync(source);
      filename = path.basename(source);
    } else {
      buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
      filename = 'image';
    }

    if (buf.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${buf.length} bytes (max ${MAX_IMAGE_SIZE})`);
    }

    const { mime, ext } = detectMime(buf);
    if (!filename.includes('.')) {
      filename = `${filename}.${ext}`;
    }

    const clientMsgId = randomHex(32);
    const data_b64 = buf.toString('base64');

    const msg: Record<string, unknown> = {
      type: 'chat.send_image',
      session_id: this._browser.sessionId,
      client_msg_id: clientMsgId,
      filename,
      mime,
      data_b64,
    };
    if (text) msg.text = text;

    return new Promise<{ messageId: string; sentAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingSends.delete(clientMsgId);
        reject(new TimeoutError('Chat sendImage timed out'));
      }, 15000);
      this._pendingSends.set(clientMsgId, { resolve, reject, timer });
      this._browser._sendRaw(msg);
    });
  }

  onMessage(cb: MessageHandler): void {
    this._messageHandlers.push(cb);
  }

  onRead(cb: ReadHandler): void {
    this._readHandlers.push(cb);
  }

  async history(opts?: ChatHistoryOptions): Promise<ChatMessage[]> {
    if (!this._topicId) return [];

    const params = new URLSearchParams();
    params.set('topic_id', this._topicId);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.beforeId) params.set('before', opts.beforeId);
    if (opts?.since) params.set('since', opts.since);

    const url = `${this._browser._chatUrl}/messages?${params.toString()}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this._browser._apiKey}`,
    };

    const basicAuth = this._browser._basicAuth;
    if (basicAuth) {
      const encoded = Buffer.from(`${basicAuth[0]}:${basicAuth[1]}`).toString('base64');
      headers['X-Basic-Auth'] = `Basic ${encoded}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Chat history request failed: ${resp.status} ${resp.statusText}`);
    }

    const body = await resp.json() as Record<string, unknown>;
    const messages = (body.messages ?? body.data ?? body) as Record<string, unknown>[];
    if (!Array.isArray(messages)) return [];

    return messages.map(parseChatMessage);
  }

  /** @internal */
  _onMessage(payload: Record<string, unknown>): void {
    const msgData = (payload.message ?? payload) as Record<string, unknown>;
    const msg = parseChatMessage(msgData);
    for (const h of this._messageHandlers) {
      try {
        const result = h(msg);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // handler errors should not break dispatch
      }
    }
  }

  /** @internal */
  _onRead(payload: Record<string, unknown>): void {
    const receipt: ReadReceipt = {
      topic_id: String(payload.topic_id ?? this._topicId ?? ''),
      last_read_message_id: String(payload.last_read_message_id ?? ''),
      read_at: Number(payload.read_at ?? 0),
    };
    for (const h of this._readHandlers) {
      try {
        const result = h(receipt);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // handler errors should not break dispatch
      }
    }
  }

  /** @internal */
  _onSendAck(msg: Record<string, unknown>): void {
    const clientMsgId = String(msg.client_msg_id ?? '');
    const pending = this._pendingSends.get(clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingSends.delete(clientMsgId);
    pending.resolve({
      messageId: String(msg.message_id ?? ''),
      sentAt: String(msg.sent_at ?? ''),
    });
  }

  /** @internal */
  _onSendError(msg: Record<string, unknown>): void {
    const clientMsgId = String(msg.client_msg_id ?? '');
    const pending = this._pendingSends.get(clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingSends.delete(clientMsgId);
    pending.reject(new ChatSendFailed(
      Number(msg.status ?? 0),
      String(msg.message ?? ''),
    ));
  }
}

function parseChatMessage(data: Record<string, unknown>): ChatMessage {
  return {
    id: String(data.id ?? data._id ?? data.message_id ?? ''),
    topic_id: String(data.topic_id ?? ''),
    sender_id: data.sender_id != null ? Number(data.sender_id) : null,
    text: data.text != null ? String(data.text) : null,
    media: (data.media as Record<string, unknown>[] | null) ?? null,
    type: String(data.type ?? 'text'),
    created_at: String(data.created_at ?? ''),
    edited_at: data.edited_at != null ? String(data.edited_at) : null,
    deleted_at: data.deleted_at != null ? String(data.deleted_at) : null,
  };
}
