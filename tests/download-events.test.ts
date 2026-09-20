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

const META = {
  guid: 'dl-guid-1',
  url: 'https://example.com/file.bin',
  suggestedFilename: 'file.bin',
  totalBytes: 1000,
  mimeType: 'application/octet-stream',
};

describe('download events (task 10135)', () => {
  it('onDownload receives Browser.downloadWillBegin', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload((ev) => received.push(ev));

    browser._onCdpEvent({
      method: 'Browser.downloadWillBegin',
      params: META,
    });

    expect(received).toHaveLength(1);
    expect(received[0].guid).toBe('dl-guid-1');
    expect(received[0].url).toBe(META.url);
    expect(received[0].totalBytes).toBe(1000);
  });

  it('onDownload receives Browser.downloadProgress', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload((ev) => received.push(ev));

    browser._onCdpEvent({
      method: 'Browser.downloadProgress',
      params: { guid: 'dl-guid-1', guidHint: 'file.bin' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].guid).toBe('dl-guid-1');
  });

  it('onDownload receives Ceki.downloadMeta (extension body-transfer)', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload((ev) => received.push(ev));

    browser._onCdpEvent({
      method: 'Ceki.downloadMeta',
      params: META,
    });

    expect(received).toHaveLength(1);
    expect(received[0].suggestedFilename).toBe('file.bin');
  });

  it('onDownload receives Ceki.downloadChunk (extension body-transfer)', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload((ev) => received.push(ev));

    browser._onCdpEvent({
      method: 'Ceki.downloadChunk',
      params: { guid: 'dl-guid-1', seq: 0, total: 2, payload: 'AAAA' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(0);
    expect(received[0].total).toBe(2);
    expect(received[0].payload).toBe('AAAA');
  });

  it('non-download CDP events do NOT reach onDownload', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload((ev) => received.push(ev));

    browser._onCdpEvent({ method: 'Page.frameNavigated', params: { url: 'https://x' } });
    browser._onCdpEvent({ method: 'Network.requestWillBeSent', params: {} });

    expect(received).toHaveLength(0);
  });

  it('handler errors do not break dispatch', () => {
    const received: Record<string, unknown>[] = [];
    browser.onDownload(() => {
      throw new Error('boom');
    });
    browser.onDownload((ev) => received.push(ev));

    expect(() =>
      browser._onCdpEvent({ method: 'Browser.downloadWillBegin', params: META }),
    ).not.toThrow();
    expect(received).toHaveLength(1);
  });
});