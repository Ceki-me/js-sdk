import { describe, it, expect, vi } from 'vitest';
import { ChatAPI } from '../src/chat.js';
import { CekiBrowserError, CommandTimeout } from '../src/errors.js';
import type { EventCallback } from '../src/transport.js';
import type { ChatMessage, TypingEvent } from '../src/types.js';

class MockTransport {
  private _pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private _nextId = 1;
  _eventCallback: EventCallback | null = null;
  sent: Array<{ method: string; params?: Record<string, unknown>; hasId: boolean }> = [];
  notified: Array<{ method: string; params?: Record<string, unknown> }> = [];

  onEvent(cb: EventCallback) { this._eventCallback = cb; }

  send(method: string, params?: Record<string, unknown>, timeout = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this.sent.push({ method, params, hasId: true });
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CommandTimeout(`Command ${method} timed out`, -1020));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.notified.push({ method, params });
  }

  resolveNext(result: unknown) {
    const first = this._pending.entries().next().value;
    if (first) {
      const [id, p] = first;
      this._pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(result);
    }
  }

  close() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new CekiBrowserError('closed'));
    }
    this._pending.clear();
  }
}

describe('ChatAPI', () => {
  it('send() sends chat.send with correct params', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const promise = chat.send('hello');
    t.resolveNext({ message_id: 'msg-001', created_at: '2026-04-28T12:00:00Z', persisted: true });
    const msg = await promise;

    expect(msg._id).toBe('msg-001');
    expect(msg.content).toBe('hello');
    expect(msg.type).toBe('text');
    expect(t.sent[0].method).toBe('chat.send');
    expect(t.sent[0].params?.session_id).toBe('sess-1');
    expect(t.sent[0].params?.type).toBe('text');
  });

  it('sendImage() sends base64 image via chat.send', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const buf = new ArrayBuffer(16);
    const promise = chat.sendImage(buf, 'image/png');
    t.resolveNext({ message_id: 'msg-002', created_at: '2026-04-28T12:00:00Z' });
    const msg = await promise;

    expect(msg._id).toBe('msg-002');
    expect(msg.type).toBe('image');
    expect(t.sent[0].params?.type).toBe('image');
    const media = t.sent[0].params?.media as Record<string, unknown>;
    expect(media.mime).toBe('image/png');
    expect(typeof media.data).toBe('string');
  });

  it('sendImage() accepts base64 string directly', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const promise = chat.sendImage('iVBOR==', 'image/png');
    t.resolveNext({ message_id: 'msg-003' });
    await promise;

    const media = t.sent[0].params?.media as Record<string, unknown>;
    expect(media.data).toBe('iVBOR==');
  });

  it('history() returns parsed messages', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const promise = chat.history();
    t.resolveNext({
      messages: [
        { _id: 'm1', author_id: 1, author_name: 'Agent', type: 'text', content: 'hi', created_at: '2026-04-28T11:00:00Z' },
        { _id: 'm2', author_id: 2, author_name: 'Provider', type: 'text', content: 'hello', created_at: '2026-04-28T11:01:00Z' },
      ],
      has_more: false,
      next_cursor: null,
    });
    const messages = await promise;

    expect(messages).toHaveLength(2);
    expect(messages[0]._id).toBe('m1');
    expect(messages[0].content).toBe('hi');
    expect(messages[1].author_name).toBe('Provider');
  });

  it('history() returns empty when no topic', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', null);
    const messages = await chat.history();
    expect(messages).toEqual([]);
  });

  it('markRead() sends chat.read', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const promise = chat.markRead('msg-last');
    t.resolveNext({ ok: true });
    await promise;

    expect(t.sent[0].method).toBe('chat.read');
    expect(t.sent[0].params?.last_message_id).toBe('msg-last');
  });

  it('typing() sends notification (no id)', async () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    await chat.typing(true);

    expect(t.notified[0].method).toBe('chat.typing');
    expect(t.notified[0].params?.is_typing).toBe(true);
    expect(t.notified[0].params?.session_id).toBe('sess-1');
  });

  it('onMessage() dispatches incoming chat.message', () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const received: ChatMessage[] = [];
    const unsub = chat.onMessage((msg) => received.push(msg));

    chat._dispatchMessage({
      message: {
        _id: 'm3', topic_id: 'topic-1', author_id: 99, author_name: 'Provider',
        type: 'text', content: 'captcha please', created_at: '2026-04-28T12:00:00Z',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('captcha please');
    expect(received[0].author_id).toBe(99);

    unsub();
    chat._dispatchMessage({ message: { _id: 'm4', content: 'ignored' } });
    expect(received).toHaveLength(1);
  });

  it('onTyping() dispatches incoming chat.typing', () => {
    const t = new MockTransport();
    const chat = new ChatAPI(t as any, 'sess-1', 'topic-1');

    const events: TypingEvent[] = [];
    const unsub = chat.onTyping((e) => events.push(e));

    chat._dispatchTyping({ user_id: 42, is_typing: true });

    expect(events).toHaveLength(1);
    expect(events[0].user_id).toBe(42);
    expect(events[0].is_typing).toBe(true);

    unsub();
    chat._dispatchTyping({ user_id: 42, is_typing: false });
    expect(events).toHaveLength(1);
  });
});
