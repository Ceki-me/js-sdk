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
import { CaptchaError, CaptchaTimeoutError } from '../src/errors.js';

let client: Client;
let ws: MockWebSocket;
let browser: Browser;
let fetchCalls: { url: string; init: RequestInit }[];

beforeEach(async () => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  process.env.CEKI_HUMAN_DISABLE = '1';
  fetchCalls = [];

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 9001, status_id: 100, amount: 0.10 }),
    };
  });

  const p = Client.create('testkey', { reconnect: false, apiUrl: 'http://localhost:9999' });
  await vi.advanceTimersByTimeAsync(1);
  client = await p;
  ws = MockWebSocket.last();

  const match = makeMatch({ chat_topic_id: 'topic-1', provider_user_id: 77, event_id: 'evt-500' });
  browser = new Browser(client, match, null);
  client._activeBrowsers.set(browser.sessionId, browser);
});

afterEach(() => {
  client._activeBrowsers.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CEKI_HUMAN_DISABLE;
});

function sendAction(kind: string, data: Record<string, unknown> = {}) {
  ws.receive({
    type: 'chat.message',
    session_id: browser.sessionId,
    payload: {
      message: {
        type: 'action',
        _id: `msg-${Date.now()}`,
        topic_id: 'topic-1',
        created_at: new Date().toISOString(),
        action: { kind, event_id: 9001, data },
      },
    },
  });
}

describe('requestCaptcha', () => {
  it('happy path with auto_accept calls vote endpoint', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: true,
    });
    await vi.advanceTimersByTimeAsync(100);

    sendAction('human_action_completed', { proof_message_id: 'proof-1', correction_id: 5555 });
    await vi.advanceTimersByTimeAsync(100);

    // auto_accept waits 2s then votes
    await vi.advanceTimersByTimeAsync(2500);

    const result = await captchaP;
    expect(result.solved).toBe(true);
    expect(result.proofMessageId).toBe('proof-1');
    expect(result.correctionId).toBe(5555);

    const voteCalls = fetchCalls.filter(c => c.url.includes('/vote'));
    expect(voteCalls).toHaveLength(1);
    expect(voteCalls[0].url).toContain('/api/agent/kal/event/9001/vote');
    const body = JSON.parse(voteCalls[0].init.body as string);
    expect(body.vote).toBe(true);
    expect(body.ids).toEqual([5555]);
  });

  it('manual accept — agent calls accept_work()', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: false,
    });
    await vi.advanceTimersByTimeAsync(100);

    sendAction('human_action_completed', { proof_message_id: 'proof-m', correction_id: 8888 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await captchaP;
    expect(result.solved).toBe(true);
    expect(result.correctionId).toBe(8888);

    await result.acceptWork();

    const voteCalls = fetchCalls.filter(c => c.url.includes('/vote'));
    expect(voteCalls).toHaveLength(1);
    expect(voteCalls[0].url).toContain('/api/agent/kal/event/9001/vote');
    const body = JSON.parse(voteCalls[0].init.body as string);
    expect(body.vote).toBe(true);
    expect(body.ids).toEqual([8888]);
  });

  it('manual reject — agent calls reject_work(reason)', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: false,
    });
    await vi.advanceTimersByTimeAsync(100);

    sendAction('human_action_completed', { proof_message_id: 'proof-r', correction_id: 6666 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await captchaP;
    expect(result.solved).toBe(true);

    await result.rejectWork('blurry');

    const voteCalls = fetchCalls.filter(c => c.url.includes('/vote'));
    expect(voteCalls).toHaveLength(1);
    const body = JSON.parse(voteCalls[0].init.body as string);
    expect(body.vote).toBe(false);
    expect(body.reason).toBe('blurry');
    expect(body.ids).toEqual([6666]);
  });

  it('no correction_id — accept_work raises CaptchaError', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: false,
    });
    await vi.advanceTimersByTimeAsync(100);

    sendAction('human_action_completed', { proof_message_id: 'proof-nc' });
    await vi.advanceTimersByTimeAsync(100);

    const result = await captchaP;
    expect(result.solved).toBe(true);
    expect(result.correctionId).toBeNull();

    await expect(result.acceptWork()).rejects.toThrow(CaptchaError);
    await expect(result.rejectWork()).rejects.toThrow(CaptchaError);
  });

  it('provider declined — returns unsolved with correctionId null', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: false,
    });
    await vi.advanceTimersByTimeAsync(100);

    sendAction('human_action_declined', {});
    await vi.advanceTimersByTimeAsync(100);

    const result = await captchaP;
    expect(result.solved).toBe(false);
    expect(result.cancelReason).toBe('declined');
    expect(result.correctionId).toBeNull();
  });

  it('captcha-request uses new endpoint with minimal payload', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 30,
      autoAccept: false,
    });
    await vi.advanceTimersByTimeAsync(100);

    const reqCalls = fetchCalls.filter(c => c.url.includes('/captcha-request'));
    expect(reqCalls).toHaveLength(1);
    expect(reqCalls[0].url).toContain('/api/agent/sessions/evt-500/captcha-request');
    const body = JSON.parse(reqCalls[0].init.body as string);
    expect(body).toEqual({ acceptance_deadline_at: 30, completion_deadline_at: 30 });
    expect(body).not.toHaveProperty('parent_id');
    expect(body).not.toHaveProperty('amount');

    sendAction('human_action_completed', { proof_message_id: 'p', correction_id: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await captchaP;
  });

  it('acceptance timeout expires captcha event via agent route', async () => {
    const captchaP = browser.requestCaptcha({
      acceptanceTimeout: 30,
      completionTimeout: 60,
      autoAccept: false,
    });

    // Catch the rejection early so Node doesn't report unhandled rejection
    captchaP.catch(() => {});

    // Advance past acceptance deadline
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(captchaP).rejects.toThrow(CaptchaTimeoutError);

    const patchCalls = fetchCalls.filter(c =>
      c.url.includes('/api/agent/kal/event/9001') && c.init.method === 'PATCH'
    );
    expect(patchCalls).toHaveLength(1);
    const body = JSON.parse(patchCalls[0].init.body as string);
    expect(body.status_id).toBe(777);
  });

  it('min timeout enforced at 30s', async () => {
    await expect(
      browser.requestCaptcha({ acceptanceTimeout: 20, completionTimeout: 60 })
    ).rejects.toThrow('acceptanceTimeout must be >= 30');

    await expect(
      browser.requestCaptcha({ acceptanceTimeout: 60, completionTimeout: 10 })
    ).rejects.toThrow('completionTimeout must be >= 30');
  });
});
