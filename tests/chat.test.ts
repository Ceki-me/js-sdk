import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MockWebSocket, makeMatch } from './helpers.js';

vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

vi.mock('../src/state.js', () => ({
  saveSession: vi.fn(),
  loadSession: vi.fn(() => null),
  deleteSession: vi.fn(),
  getLastSeenTs: vi.fn(() => null),
  updateLastSeenTs: vi.fn(),
}));

import { Browser } from '../src/browser.js';
import { Client } from '../src/client.js';
import { TimeoutError, ChatSendFailed } from '../src/errors.js';
import type { ChatMessage } from '../src/types.js';

let client: Client;
let ws: MockWebSocket;
let browser: Browser;

beforeEach(async () => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  process.env.CEKI_HUMAN_DISABLE = '1';

  const p = Client.create('key', { reconnect: false });
  await vi.advanceTimersByTimeAsync(1);
  client = await p;
  ws = MockWebSocket.last();

  const match = makeMatch();
  browser = new Browser(client, match, null);
  client._activeBrowsers.set(browser.sessionId, browser);
});

afterEach(() => {
  client._activeBrowsers.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete process.env.CEKI_HUMAN_DISABLE;
});

describe('chat.send()', () => {
  it('sends chat.send, receives ack, returns messageId + sentAt', async () => {
    const sendP = browser.chat.send('hello');

    // Find the chat.send message
    const chatMsg = ws.sent.find(m => m.type === 'chat.send');
    expect(chatMsg).toBeDefined();
    expect(chatMsg!.text).toBe('hello');
    expect(chatMsg!.session_id).toBe(browser.sessionId);

    // Send ack
    ws.receive({
      type: 'chat.send_ack',
      session_id: browser.sessionId,
      client_msg_id: chatMsg!.client_msg_id,
      message_id: 'msg-100',
      sent_at: '2024-01-01T00:00:00Z',
    });

    const result = await sendP;
    expect(result.messageId).toBe('msg-100');
    expect(result.sentAt).toBe('2024-01-01T00:00:00Z');
  });

  it('rejects with TimeoutError after 15s', async () => {
    const sendP = browser.chat.send('timeout test').catch(e => e);
    await vi.advanceTimersByTimeAsync(16_000);
    const err = await sendP;
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('rejects with ChatSendFailed on error', async () => {
    const sendP = browser.chat.send('fail test');

    const chatMsg = ws.sent.find(m => m.type === 'chat.send');
    ws.receive({
      type: 'chat.error',
      session_id: browser.sessionId,
      client_msg_id: chatMsg!.client_msg_id,
      status: 400,
      message: 'Bad request',
    });

    await expect(sendP).rejects.toThrow(ChatSendFailed);
  });
});

describe('chat.sendImage()', () => {
  it('sends chat.send_image with buffer, detects MIME (PNG)', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngBuf = Buffer.concat([pngHeader, Buffer.alloc(100)]);

    const sendP = browser.chat.sendImage(pngBuf);

    const imgMsg = ws.sent.find(m => m.type === 'chat.send_image');
    expect(imgMsg).toBeDefined();
    expect(imgMsg!.mime).toBe('image/png');
    expect(imgMsg!.session_id).toBe(browser.sessionId);

    ws.receive({
      type: 'chat.send_ack',
      session_id: browser.sessionId,
      client_msg_id: imgMsg!.client_msg_id,
      message_id: 'img-1',
      sent_at: '2024-01-01T00:00:00Z',
    });

    const result = await sendP;
    expect(result.messageId).toBe('img-1');
  });

  it('sends chat.send_image from file path', async () => {
    // Create actual temp file with JPEG header
    vi.useRealTimers(); // need real timers for fs
    const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const jpgBuf = Buffer.concat([jpgHeader, Buffer.alloc(100)]);
    const tmpFile = path.join(os.tmpdir(), `test-chat-${Date.now()}.jpg`);
    fs.writeFileSync(tmpFile, jpgBuf);
    vi.useFakeTimers();

    try {
      const sendP = browser.chat.sendImage(tmpFile);

      const imgMsg = ws.sent.find(m => m.type === 'chat.send_image');
      expect(imgMsg).toBeDefined();
      expect(imgMsg!.mime).toBe('image/jpeg');
      expect(imgMsg!.filename).toContain('.jpg');

      ws.receive({
        type: 'chat.send_ack',
        session_id: browser.sessionId,
        client_msg_id: imgMsg!.client_msg_id,
        message_id: 'img-2',
        sent_at: '2024-01-01T00:00:00Z',
      });

      await sendP;
    } finally {
      vi.useRealTimers();
      try { fs.unlinkSync(tmpFile); } catch {}
      vi.useFakeTimers();
    }
  });
});

describe('chat.history()', () => {
  it('calls HTTP GET with correct params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { id: 'm1', topic_id: 'topic-1', text: 'hi', type: 'text', created_at: '2024-01-01T00:00:00Z' },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const msgs = await browser.chat.history({ limit: 5, since: '2024-01-01' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('topic_id=topic-1');
    expect(url).toContain('limit=5');
    expect(url).toContain('since=2024-01-01');
    expect(opts.headers.Authorization).toBe('Bearer key');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('hi');

    vi.unstubAllGlobals();
  });
});

describe('chat.onMessage()', () => {
  it('dispatches incoming chat messages', () => {
    const received: ChatMessage[] = [];
    browser.chat.onMessage((msg) => {
      received.push(msg);
    });

    ws.receive({
      type: 'chat.message',
      session_id: browser.sessionId,
      payload: {
        message: {
          id: 'msg-in-1',
          topic_id: 'topic-1',
          sender_id: 7,
          text: 'hello from provider',
          type: 'text',
          created_at: '2024-01-01T12:00:00Z',
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hello from provider');
    expect(received[0].sender_id).toBe(7);
  });
});

describe('chat.onRead()', () => {
  it('dispatches read receipts', () => {
    const receipts: Array<{ topic_id: string; last_read_message_id: string }> = [];
    browser.chat.onRead((r) => {
      receipts.push(r);
    });

    ws.receive({
      type: 'chat.read',
      session_id: browser.sessionId,
      payload: {
        topic_id: 'topic-1',
        last_read_message_id: 'msg-5',
        read_at: 1704067200,
      },
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0].last_read_message_id).toBe('msg-5');
  });
});
