import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockWebSocket } from './helpers.js';

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

import { Client } from '../src/client.js';

const MOCK_SESSIONS = [
  {
    id: 2650,
    schedule_id: 703,
    started_at: '2026-05-18T10:43:09Z',
    ended_at: null,
    status: 'active',
    duration: 148,
    earned: 0.25,
    price_per_min: 0.10,
    renter: { type: 'agent', id: 4, name: 'First' },
    provider: { type: 'user', id: 1, name: 'Konstantin' },
    data: { chat_topic_id: 'topic-abc' },
  },
];

let client: Client;
let fetchCalls: { url: string; init: RequestInit }[];

beforeEach(async () => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  fetchCalls = [];

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: MOCK_SESSIONS }),
    };
  });

  const p = Client.create('testkey', { reconnect: false, apiUrl: 'http://localhost:9999' });
  await vi.advanceTimersByTimeAsync(1);
  client = await p;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('listSessions', () => {
  it('returns sessions from API with active=true by default', async () => {
    const results = await client.listSessions();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(2650);
    expect(results[0].status).toBe('active');
    expect(results[0].renter.name).toBe('First');

    const call = fetchCalls.find(c => c.url.includes('/api/agent/sessions'));
    expect(call).toBeDefined();
    expect(call!.url).toContain('active=1');
    expect(call!.url).toContain('limit=50');
  });

  it('passes active=0 when active is false', async () => {
    await client.listSessions({ active: false });
    const call = fetchCalls.find(c => c.url.includes('/api/agent/sessions'));
    expect(call!.url).toContain('active=0');
  });

  it('passes custom limit', async () => {
    await client.listSessions({ limit: 10 });
    const call = fetchCalls.find(c => c.url.includes('/api/agent/sessions'));
    expect(call!.url).toContain('limit=10');
  });

  it('returns empty array for empty response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    const results = await client.listSessions();
    expect(results).toEqual([]);
  });
});
