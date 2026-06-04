import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockWebSocket } from './helpers.js';

// Mock ws module before importing Client
vi.mock('ws', () => {
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

// Mock state module to avoid filesystem access
vi.mock('../src/state.js', () => ({
  saveSession: vi.fn(),
  loadSession: vi.fn(() => null),
  deleteSession: vi.fn(),
  getLastSeenTs: vi.fn(() => null),
  updateLastSeenTs: vi.fn(),
}));

import { Client, connect } from '../src/client.js';
import {
  CekiBrowserError,
  InsufficientFunds,
  ProviderOffline,
  RateLimitExceeded,
  TimeoutError,
  SessionExpired,
  NotOwner,
  SessionNotFound,
} from '../src/errors.js';

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  // Disable humanizer via env
  process.env.CEKI_HUMAN_DISABLE = '1';
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete process.env.CEKI_HUMAN_DISABLE;
});

async function createClient(): Promise<Client> {
  const p = Client.create('test-key', { reconnect: false });
  await vi.advanceTimersByTimeAsync(1);
  return p;
}

describe('Client.create / connect()', () => {
  it('creates a connected Client via factory', async () => {
    const client = await createClient();
    expect(client).toBeInstanceOf(Client);
    expect(MockWebSocket.last().protocols).toContain('bearer.test-key');
  });

  it('connect() is an alias for Client.create()', async () => {
    const p = connect('test-key', { reconnect: false });
    await vi.advanceTimersByTimeAsync(1);
    const client = await p;
    expect(client).toBeInstanceOf(Client);
  });
});

describe('search()', () => {
  it('calls HTTP API with Bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ schedule_id: 1, price_per_min: 0.5, online: true }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = await createClient();
    const results = await client.search({ geo: 'US' }, 10);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/browsers/search');
    expect(url).toContain('geo=US');
    expect(url).toContain('limit=10');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    expect(results).toHaveLength(1);
    expect(results[0].schedule_id).toBe(1);

    vi.unstubAllGlobals();
  });
});

describe('rent()', () => {
  it('sends rent, receives rent_pending then match, resolves Browser', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);

    expect(ws.sent).toContainEqual({ type: 'rent', browser_id: 42 });

    // Server sends rent_pending
    ws.receive({ type: 'rent_pending', event_id: 'evt-1' });

    // Server sends match
    ws.receive({
      type: 'match',
      event_id: 'evt-1',
      schedule_id: 42,
      session_id: 'sess-abc',
      chat_topic_id: 'topic-1',
      provider_user_id: 7,
      browser_info: { ua: 'Chrome' },
    });

    const browser = await rentPromise;
    expect(browser.sessionId).toBe('sess-abc');
    expect(browser.scheduleId).toBe(42);
    expect(browser.chatTopicId).toBe('topic-1');
  });

  it('forwards mode in rent WS message when given (task 399 / #310)', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42, { mode: 'main' });

    expect(ws.sent).toContainEqual({ type: 'rent', browser_id: 42, mode: 'main' });

    ws.receive({ type: 'rent_pending', event_id: 'evt-mode' });
    ws.receive({
      type: 'match',
      event_id: 'evt-mode',
      schedule_id: 42,
      session_id: 'sess-mode',
      chat_topic_id: 'topic-mode',
      provider_user_id: 7,
      browser_info: { ua: 'Chrome' },
    });

    await rentPromise;
  });

  it('rejects with ProviderOffline on provider_offline error', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);

    ws.receive({ type: 'rent_pending', event_id: 'evt-2' });
    ws.receive({
      type: 'rent.error',
      event_id: 'evt-2',
      code: 'provider_offline',
      message: 'Provider is offline',
    });

    await expect(rentPromise).rejects.toThrow(ProviderOffline);
  });

  it('rejects with TimeoutError after 90s', async () => {
    const client = await createClient();

    const rentPromise = client.rent(42).catch(e => e);
    await vi.advanceTimersByTimeAsync(91_000);

    const err = await rentPromise;
    expect(err).toBeInstanceOf(TimeoutError);
  });
});

describe('resume()', () => {
  it('sends resume, receives resume_ok, resolves Browser', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const resumePromise = client.resume('sess-xyz');

    expect(ws.sent).toContainEqual({ type: 'resume', session_id: 'sess-xyz' });

    ws.receive({
      type: 'resume_ok',
      session_id: 'sess-xyz',
      schedule_id: 10,
      chat_topic_id: 'topic-2',
      browser_info: {},
    });

    const browser = await resumePromise;
    expect(browser.sessionId).toBe('sess-xyz');
    expect(browser.scheduleId).toBe(10);
  });

  it('resume_ok propagates event_id to Browser', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const resumePromise = client.resume('sess-ev');

    ws.receive({
      type: 'resume_ok',
      session_id: 'sess-ev',
      event_id: 'evt-777',
      schedule_id: 10,
      chat_topic_id: null,
      browser_info: {},
    });

    const browser = await resumePromise;
    expect(browser.sessionId).toBe('sess-ev');
    expect((browser as any)._eventId).toBe('evt-777');
  });

  it('rejects with SessionExpired on expired reason', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const resumePromise = client.resume('sess-old');
    ws.receive({ type: 'resume_failed', session_id: 'sess-old', reason: 'expired' });

    await expect(resumePromise).rejects.toThrow(SessionExpired);
  });

  it('rejects with NotOwner on not_owner reason', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const resumePromise = client.resume('sess-other');
    ws.receive({ type: 'resume_failed', session_id: 'sess-other', reason: 'not_owner' });

    await expect(resumePromise).rejects.toThrow(NotOwner);
  });

  it('rejects with SessionNotFound on not_found reason', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const resumePromise = client.resume('sess-gone');
    ws.receive({ type: 'resume_failed', session_id: 'sess-gone', reason: 'not_found' });

    await expect(resumePromise).rejects.toThrow(SessionNotFound);
  });

  it('rejects with TimeoutError after 10s', async () => {
    const client = await createClient();

    const resumePromise = client.resume('sess-slow').catch(e => e);
    await vi.advanceTimersByTimeAsync(11_000);

    const err = await resumePromise;
    expect(err).toBeInstanceOf(TimeoutError);
  });
});

describe('generic error dispatch', () => {
  it('rejects pending rent with CekiBrowserError on generic error code -1014', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);
    ws.receive({ type: 'rent_pending', event_id: 'evt-err' });
    ws.receive({
      type: 'error',
      code: -1014,
      message: 'Insufficient balance',
    });

    await expect(rentPromise).rejects.toThrow(CekiBrowserError);
    await expect(rentPromise).rejects.toThrow('Insufficient balance');
  });

  it('rejects pending rent with InsufficientFunds on error code -1012', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);
    ws.receive({
      type: 'error',
      code: -1012,
      message: 'Not enough funds',
    });

    await expect(rentPromise).rejects.toThrow(InsufficientFunds);
  });

  it('rejects pending rent with RateLimitExceeded on error code -1013', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);
    ws.receive({
      type: 'error',
      code: -1013,
      message: 'Rate limited',
    });

    await expect(rentPromise).rejects.toThrow(RateLimitExceeded);
  });

  it('rejects pending rent with ProviderOffline on error code -1015', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(42);
    ws.receive({
      type: 'error',
      code: -1015,
      message: 'No providers available',
    });

    await expect(rentPromise).rejects.toThrow(ProviderOffline);
  });
});

describe('close()', () => {
  it('closes all active browsers and WS', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    // Rent a browser
    const rentPromise = client.rent(1);
    ws.receive({ type: 'rent_pending', event_id: 'e1' });
    ws.receive({ type: 'match', event_id: 'e1', schedule_id: 1, session_id: 's1' });
    const browser = await rentPromise;

    // Simulate the server confirming session ended when close sends session.end
    const origSend = ws.send.bind(ws);
    vi.spyOn(ws, 'send').mockImplementation((data: string) => {
      origSend(data);
      const msg = JSON.parse(data);
      if (msg.type === 'session.end') {
        ws.receive({ type: 'session.ended', session_id: msg.session_id, reason: 'user_stop' });
      }
    });

    await client.close();
    expect(ws.readyState).toBe(3);
  });
});

describe('disconnect()', () => {
  it('closes WS without sending session.end', async () => {
    const client = await createClient();
    const ws = MockWebSocket.last();

    const rentPromise = client.rent(1);
    ws.receive({ type: 'rent_pending', event_id: 'e1' });
    ws.receive({ type: 'match', event_id: 'e1', schedule_id: 1, session_id: 's1' });
    await rentPromise;

    await client.disconnect();
    const sessionEndSent = ws.sent.some(m => m.type === 'session.end');
    expect(sessionEndSent).toBe(false);
    expect(ws.readyState).toBe(3);
  });
});
