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

// Mock the WebRTC transport so Client._initP2P can be exercised without a real
// RTCPeerConnection. The transport-level reassembly itself is covered in
// tests/webrtc-chunk.test.ts.
vi.mock('../src/webrtc.js', () => ({
  WebRTCTransport: vi.fn().mockImplementation(() => ({
    createOffer: vi.fn().mockResolvedValue('v=0'),
    localFingerprint: 'fp',
    waitForDcOpen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { Browser } from '../src/browser.js';
import { Client } from '../src/client.js';

/** Minimal client stub — enough for the Browser constructor + send() routing. */
function makeMockClient() {
  return {
    _apiKey: 'key',
    _chatUrl: 'wss://chat.example.com',
    _basicAuth: undefined,
    _activeBrowsers: new Map<string, Browser>(),
    _p2p: null,
    _wsSend: vi.fn(),
  } as unknown as Client;
}

function makeBrowser() {
  const client = makeMockClient();
  const browser = new Browser(client, makeMatch(), null);
  client._activeBrowsers.set(browser.sessionId, browser);
  return { client, browser };
}

describe('Browser.startScreencast', () => {
  it('sends Page.startScreencast with the given params', async () => {
    const { browser } = makeBrowser();
    const send = vi.spyOn(browser, 'send').mockResolvedValue({});

    await browser.startScreencast({ maxWidth: 1280, maxHeight: 720, quality: 80 });

    expect(send).toHaveBeenCalledWith({
      method: 'Page.startScreencast',
      params: { maxWidth: 1280, maxHeight: 720, quality: 80 },
    });
  });

  it('sends Page.startScreencast with empty params when none given', async () => {
    const { browser } = makeBrowser();
    const send = vi.spyOn(browser, 'send').mockResolvedValue({});

    await browser.startScreencast();

    expect(send).toHaveBeenCalledWith({
      method: 'Page.startScreencast',
      params: {},
    });
  });
});

describe('Browser.stopScreencast', () => {
  it('sends Page.stopScreencast', async () => {
    const { browser } = makeBrowser();
    const send = vi.spyOn(browser, 'send').mockResolvedValue({});

    await browser.stopScreencast();

    expect(send).toHaveBeenCalledWith({ method: 'Page.stopScreencast' });
  });
});

describe('Browser.onCaptureFrame', () => {
  it('delivers video-frame messages to registered callbacks', () => {
    const { browser } = makeBrowser();
    const frames: Record<string, unknown>[] = [];
    browser.onCaptureFrame((frame) => frames.push(frame));

    const frame = { type: 'video-frame', timestamp: 1, data: 'abc' };
    browser._onCaptureData(frame);

    expect(frames).toEqual([frame]);
  });

  it('ignores non-video-frame capture-DC messages', () => {
    const { browser } = makeBrowser();
    const frames: Record<string, unknown>[] = [];
    browser.onCaptureFrame((frame) => frames.push(frame));

    browser._onCaptureData({ type: 'video-stopped' });
    browser._onCaptureData({ type: 'screenshot', data: 'x' });

    expect(frames).toEqual([]);
  });
});

describe('Client._initP2P capture wiring', () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
    process.env.CEKI_HUMAN_DISABLE = '1';
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete process.env.CEKI_HUMAN_DISABLE;
  });

  it('wires transport.onCaptureData and routes frames to the active browser', async () => {
    const p = Client.create('key', { reconnect: false });
    await vi.advanceTimersByTimeAsync(1);
    const client = await p;

    const browser = new Browser(client, makeMatch(), null);
    client._activeBrowsers.set(browser.sessionId, browser);

    const frames: Record<string, unknown>[] = [];
    browser.onCaptureFrame((frame) => frames.push(frame));

    await (client as unknown as { _initP2P: (sid: string) => Promise<void> })
      ._initP2P('sess-test-123');

    const transport = client._p2p as unknown as {
      onCaptureData: ((msg: Record<string, unknown>) => void) | null;
    };
    expect(transport.onCaptureData).toBeTypeOf('function');

    transport.onCaptureData!({ type: 'video-frame', data: 'abc' });

    expect(frames).toEqual([{ type: 'video-frame', data: 'abc' }]);
  });
});
