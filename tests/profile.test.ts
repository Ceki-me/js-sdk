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
import type { Profile } from '../src/types.js';

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

  // Auto-respond to CDP calls based on method
  const origSend = ws.send.bind(ws);
  vi.spyOn(ws, 'send').mockImplementation((data: string) => {
    origSend(data);
    const msg = JSON.parse(data);
    if (msg.type === 'cdp') {
      const method = msg.method as string;
      let result: unknown = {};

      if (method === 'Browser.getFingerprint') {
        result = { canvas: 'abc123' };
      } else if (method === 'Network.getCookies') {
        result = {
          cookies: [
            { name: 'sid', value: '123', domain: '.example.com' },
            { name: 'other', value: '456', domain: '.other.com' },
          ],
        };
      } else if (method === 'Network.setCookies') {
        result = {};
      } else if (method === 'Runtime.evaluate') {
        const expr = (msg.params as Record<string, unknown>).expression as string;
        if (expr.includes('localStorage') && !expr.includes('setItem')) {
          result = { result: { value: JSON.stringify({ key1: 'val1' }) } };
        } else if (expr.includes('sessionStorage') && !expr.includes('setItem')) {
          result = { result: { value: JSON.stringify({ skey: 'sval' }) } };
        } else if (expr.includes('location.origin')) {
          result = { result: { value: 'https://example.com' } };
        } else {
          result = { result: { value: 'ok' } };
        }
      }

      queueMicrotask(() => {
        ws.receive({
          type: 'cdp_response',
          session_id: browser.sessionId,
          id: msg.id,
          result,
        });
      });
    }
  });
});

afterEach(() => {
  client._activeBrowsers.clear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  delete process.env.CEKI_HUMAN_DISABLE;
});

describe('profile.export()', () => {
  it('calls Browser.getFingerprint, Network.getCookies, Runtime.evaluate for localStorage/sessionStorage/origin', async () => {
    const profile = await browser.profile.export();

    expect(profile.schema_version).toBe(2);
    expect(profile.fingerprint).toEqual({ canvas: 'abc123' });
    expect(profile.cookies).toHaveLength(2);
    expect(profile.localStorage).toEqual({ key1: 'val1' });
    expect(profile.sessionStorage).toEqual({ skey: 'sval' });
    expect(profile.origin).toBe('https://example.com');

    const methods = ws.sent.filter(m => m.type === 'cdp').map(m => m.method);
    expect(methods).toContain('Browser.getFingerprint');
    expect(methods).toContain('Network.getCookies');
  });

  it('filters cookies by domain when domains option provided', async () => {
    const profile = await browser.profile.export({ domains: ['example.com'] });

    expect(profile.cookies).toHaveLength(1);
    expect((profile.cookies![0] as Record<string, unknown>).domain).toBe('.example.com');
  });

  it('skips sessionStorage when includeSessionStorage is false', async () => {
    const profile = await browser.profile.export({ includeSessionStorage: false });

    expect(profile.sessionStorage).toEqual({});

    const evalCalls = ws.sent.filter(
      m => m.type === 'cdp' && m.method === 'Runtime.evaluate' &&
        ((m.params as Record<string, unknown>).expression as string).includes('sessionStorage') &&
        !((m.params as Record<string, unknown>).expression as string).includes('setItem'),
    );
    expect(evalCalls).toHaveLength(0);
  });
});

describe('profile.import()', () => {
  it('calls Network.setCookies + Runtime.evaluate for localStorage/sessionStorage', async () => {
    const profile: Profile = {
      schema_version: 2,
      cookies: [{ name: 'c1', value: 'v1', domain: '.test.com' }],
      localStorage: { lk: 'lv' },
      sessionStorage: { sk: 'sv' },
    };

    await browser.profile.import(profile);

    const methods = ws.sent.filter(m => m.type === 'cdp').map(m => m.method);
    expect(methods).toContain('Network.setCookies');

    const evalCalls = ws.sent.filter(
      m => m.type === 'cdp' && m.method === 'Runtime.evaluate',
    );
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('validates schema_version', async () => {
    const badProfile: Profile = {
      schema_version: 99,
      cookies: [],
    };

    await expect(browser.profile.import(badProfile)).rejects.toThrow('Unsupported profile schema_version');
  });

  it('accepts schema_version 1', async () => {
    const profile: Profile = {
      schema_version: 1,
      cookies: [],
    };

    await browser.profile.import(profile);
    // Should not throw
  });
});
