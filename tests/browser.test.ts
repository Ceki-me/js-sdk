import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { SessionEnded } from '../src/errors.js';

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
  // Clean up without calling client.close() which needs timers
  client._activeBrowsers.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete process.env.CEKI_HUMAN_DISABLE;
});

/** Auto-respond to CDP requests with given result */
function autoRespondCdp(result: unknown = {}) {
  const origSend = ws.send.bind(ws);
  vi.spyOn(ws, 'send').mockImplementation((data: string) => {
    origSend(data);
    const msg = JSON.parse(data);
    if (msg.type === 'cdp') {
      // Use queueMicrotask to resolve before timers but after current tick
      queueMicrotask(() => {
        ws.receive({ type: 'cdp_response', session_id: browser.sessionId, id: msg.id, result });
      });
    }
  });
}

describe('navigate()', () => {
  it('sends CDP Page.navigate via WS and receives response', async () => {
    autoRespondCdp({ url: 'https://example.com', frameId: 'F1' });

    const result = await browser.navigate('https://example.com');

    expect(result.url).toBe('https://example.com');
    expect(result.frameId).toBe('F1');

    const cdpMsg = ws.sent.find(m => m.type === 'cdp' && m.method === 'Page.navigate');
    expect(cdpMsg).toBeDefined();
    expect((cdpMsg!.params as Record<string, unknown>).url).toBe('https://example.com');
  });
});

describe('click()', () => {
  it('sends mousePressed + mouseReleased, stores lastPointer', async () => {
    autoRespondCdp({});

    await browser.click(100, 200);

    const pressed = ws.sent.find(
      m => m.type === 'cdp' && m.method === 'Input.dispatchMouseEvent' &&
        (m.params as Record<string, unknown>).type === 'mousePressed',
    );
    const released = ws.sent.find(
      m => m.type === 'cdp' && m.method === 'Input.dispatchMouseEvent' &&
        (m.params as Record<string, unknown>).type === 'mouseReleased',
    );
    expect(pressed).toBeDefined();
    expect(released).toBeDefined();
    expect((pressed!.params as Record<string, unknown>).x).toBe(100);
    expect((released!.params as Record<string, unknown>).y).toBe(200);
    expect(browser._lastPointer).toEqual([100, 200]);
  });
});

describe('type()', () => {
  it('without humanizer sends single Input.insertText', async () => {
    autoRespondCdp({});

    await browser.type('hello');

    const insertMsgs = ws.sent.filter(
      m => m.type === 'cdp' && m.method === 'Input.insertText',
    );
    expect(insertMsgs).toHaveLength(1);
    expect((insertMsgs[0].params as Record<string, unknown>).text).toBe('hello');
  });

  it('with humanizer sends char-by-char with delays', async () => {
    const { Humanizer } = await import('../src/humanize/humanizer.js');
    const { HumanProfile } = await import('../src/humanize/profile.js');
    const humanProfile = HumanProfile.fromDict({
      rng_seed: 42,
      // Use tiny delays for test speed
      pre_action_ms: { type: [0, 0] },
      post_action_ms: { type: [0, 0] },
      typing: { wpm: 99999, jitter: 0, thinking_pause_prob: 0 },
    });
    browser._humanizer = new Humanizer(humanProfile);

    autoRespondCdp({});

    const typeP = browser.type('ab');
    // Advance timers enough for the type delays
    await vi.advanceTimersByTimeAsync(500);
    await typeP;

    const insertMsgs = ws.sent.filter(
      m => m.type === 'cdp' && m.method === 'Input.insertText',
    );
    // Should have 2 chars typed individually
    expect(insertMsgs.length).toBe(2);
    expect((insertMsgs[0].params as Record<string, unknown>).text).toBe('a');
    expect((insertMsgs[1].params as Record<string, unknown>).text).toBe('b');
  });
});

describe('scroll()', () => {
  it('sends mouseWheel CDP command', async () => {
    autoRespondCdp({});

    await browser.scroll({ x: 50, y: 60, deltaY: -300 });

    const wheelMsg = ws.sent.find(
      m => m.type === 'cdp' && m.method === 'Input.dispatchMouseEvent' &&
        (m.params as Record<string, unknown>).type === 'mouseWheel',
    );
    expect(wheelMsg).toBeDefined();
    expect((wheelMsg!.params as Record<string, unknown>).x).toBe(50);
    expect((wheelMsg!.params as Record<string, unknown>).deltaY).toBe(-300);
  });
});

describe('screenshot()', () => {
  it('format base64 returns { data: string }', async () => {
    const fakeB64 = Buffer.from('fake-png').toString('base64');
    autoRespondCdp({ data: fakeB64 });

    const result = await browser.screenshot({ format: 'base64' });

    expect(result).toHaveProperty('data');
    expect((result as { data: string }).data).toBe(fakeB64);
  });

  it('format png returns Buffer', async () => {
    const fakeB64 = Buffer.from('fake-png').toString('base64');
    autoRespondCdp({ data: fakeB64 });

    const result = await browser.screenshot({ format: 'png' });

    expect(Buffer.isBuffer(result)).toBe(true);
  });
});

describe('snapshot()', () => {
  it('returns screenshot + chat history + timestamp', async () => {
    const fakeB64 = Buffer.from('fake-png').toString('base64');
    autoRespondCdp({ data: fakeB64 });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { id: 'msg-1', topic_id: 'topic-1', text: 'hello', type: 'text', created_at: '2024-01-01T00:00:00Z' },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const snap = await browser.snapshot();

    expect(snap.screenshot).toBe(fakeB64);
    expect(snap.chat).toHaveLength(1);
    expect(snap.chat[0].text).toBe('hello');
    expect(snap.ts).toBeInstanceOf(Date);

    vi.unstubAllGlobals();
  });
});

describe('switchTab()', () => {
  it('sends { type: "switch_tab" }', async () => {
    await browser.switchTab();
    const msg = ws.sent.find(m => m.type === 'switch_tab');
    expect(msg).toBeDefined();
    expect(msg!.session_id).toBe(browser.sessionId);
  });
});

describe('configure()', () => {
  it('sends { type: "session.configure" }', async () => {
    await browser.configure({ maskingMode: true });
    const msg = ws.sent.find(m => m.type === 'session.configure');
    expect(msg).toBeDefined();
    expect(msg!.masking_mode).toBe(true);
  });
});

describe('close()', () => {
  it('sends session.end and resolves waitUntilEnded', async () => {
    const endedP = browser.waitUntilEnded();

    // Spy to auto-respond with session.ended
    const origSend = ws.send.bind(ws);
    vi.spyOn(ws, 'send').mockImplementation((data: string) => {
      origSend(data);
      const msg = JSON.parse(data);
      if (msg.type === 'session.end') {
        queueMicrotask(() => {
          ws.receive({ type: 'session.ended', session_id: browser.sessionId, reason: 'user_stop' });
        });
      }
    });

    await browser.close();
    const reason = await endedP;
    expect(reason).toBe('user_stop');

    const endMsg = ws.sent.find(m => m.type === 'session.end');
    expect(endMsg).toBeDefined();
  });
});

describe('release()', () => {
  it('is an alias for close()', async () => {
    const origSend = ws.send.bind(ws);
    vi.spyOn(ws, 'send').mockImplementation((data: string) => {
      origSend(data);
      const msg = JSON.parse(data);
      if (msg.type === 'session.end') {
        queueMicrotask(() => {
          ws.receive({ type: 'session.ended', session_id: browser.sessionId, reason: 'user_stop' });
        });
      }
    });

    await browser.release();
    expect(browser._endedReason).toBe('user_stop');
  });
});

describe('session ended events', () => {
  it('maps session.ended to SessionEnded', async () => {
    ws.receive({ type: 'session.ended', session_id: browser.sessionId, reason: 'provider_declined' });

    expect(browser._endedReason).toBe('provider_declined');

    await expect(browser.send({ method: 'Page.navigate', params: {} })).rejects.toThrow(SessionEnded);
  });
});
