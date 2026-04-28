import type { Transport } from './transport.js';
import type { ChatMessage, TypingEvent } from './types.js';

type MessageHandler = (msg: ChatMessage) => void;
type TypingHandler = (event: TypingEvent) => void;

function parseChatMessage(data: Record<string, unknown>): ChatMessage {
  return {
    _id: String(data._id ?? data.message_id ?? data.id ?? ''),
    topic_id: String(data.topic_id ?? ''),
    author_id: Number(data.author_id ?? data.user_id ?? 0),
    author_name: String(data.author_name ?? ''),
    type: (data.type as ChatMessage['type']) ?? 'text',
    content: String(data.content ?? ''),
    media: (data.media as ChatMessage['media']) ?? null,
    created_at: String(data.created_at ?? ''),
  };
}

export class ChatAPI {
  private _transport: Transport;
  private _sessionId: string;
  private _topicId: string | null;
  private _messageHandlers: MessageHandler[] = [];
  private _typingHandlers: TypingHandler[] = [];

  constructor(transport: Transport, sessionId: string, topicId: string | null) {
    this._transport = transport;
    this._sessionId = sessionId;
    this._topicId = topicId;
  }

  get topicId(): string | null {
    return this._topicId;
  }

  get available(): boolean {
    return this._topicId !== null;
  }

  /** @internal */
  _setTopicId(topicId: string): void {
    this._topicId = topicId;
  }

  async send(text: string): Promise<ChatMessage> {
    const data = (await this._transport.send(
      'chat.send',
      { session_id: this._sessionId, type: 'text', content: text },
      15000,
    )) as Record<string, unknown> | null;
    const result = data ?? {};
    return {
      _id: String(result.message_id ?? ''),
      topic_id: this._topicId ?? '',
      author_id: 0,
      author_name: '',
      type: 'text',
      content: text,
      media: null,
      created_at: String(result.created_at ?? ''),
    };
  }

  async sendImage(image: Blob | ArrayBuffer | string, mime = 'image/png'): Promise<ChatMessage> {
    let b64: string;
    if (typeof image === 'string') {
      b64 = image;
    } else if (image instanceof ArrayBuffer) {
      b64 = bufferToBase64(new Uint8Array(image));
    } else {
      const buf = await image.arrayBuffer();
      b64 = bufferToBase64(new Uint8Array(buf));
    }

    const name = `image.${mime.split('/').pop() ?? 'png'}`;
    const data = (await this._transport.send(
      'chat.send',
      {
        session_id: this._sessionId,
        type: 'image',
        content: '',
        media: { data: b64, mime, name },
      },
      30000,
    )) as Record<string, unknown> | null;
    const result = data ?? {};
    return {
      _id: String(result.message_id ?? ''),
      topic_id: this._topicId ?? '',
      author_id: 0,
      author_name: '',
      type: 'image',
      content: '',
      media: null,
      created_at: String(result.created_at ?? ''),
    };
  }

  async history(opts?: { before?: string; limit?: number }): Promise<ChatMessage[]> {
    if (!this._topicId) return [];
    const params: Record<string, unknown> = {
      session_id: this._sessionId,
      limit: opts?.limit ?? 50,
    };
    if (opts?.before) params.before = opts.before;
    const data = (await this._transport.send('chat.history', params, 15000)) as Record<string, unknown> | null;
    const result = data ?? {};
    const messages = (result.messages ?? []) as Record<string, unknown>[];
    return messages.map(parseChatMessage);
  }

  async markRead(lastMessageId: string): Promise<void> {
    if (!this._topicId) return;
    await this._transport.send(
      'chat.read',
      { session_id: this._sessionId, last_message_id: lastMessageId },
      10000,
    );
  }

  async typing(isTyping = true): Promise<void> {
    this._transport.notify('chat.typing', {
      session_id: this._sessionId,
      is_typing: isTyping,
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this._messageHandlers.push(handler);
    return () => {
      const idx = this._messageHandlers.indexOf(handler);
      if (idx >= 0) this._messageHandlers.splice(idx, 1);
    };
  }

  onTyping(handler: TypingHandler): () => void {
    this._typingHandlers.push(handler);
    return () => {
      const idx = this._typingHandlers.indexOf(handler);
      if (idx >= 0) this._typingHandlers.splice(idx, 1);
    };
  }

  /** @internal */
  _dispatchMessage(params: Record<string, unknown>): void {
    const msgData = (params.message ?? params) as Record<string, unknown>;
    const msg = parseChatMessage(msgData);
    for (const h of this._messageHandlers) {
      try {
        h(msg);
      } catch {
        // handler errors should not break the event loop
      }
    }
  }

  /** @internal */
  _dispatchTyping(params: Record<string, unknown>): void {
    const event: TypingEvent = {
      user_id: Number(params.user_id ?? 0),
      is_typing: Boolean(params.is_typing),
    };
    for (const h of this._typingHandlers) {
      try {
        h(event);
      } catch {
        // handler errors should not break the event loop
      }
    }
  }
}

function bufferToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
