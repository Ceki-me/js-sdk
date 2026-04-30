import { describe, it, expect } from 'vitest';
import { Session } from '../src/session.js';
import { CekiBrowserError } from '../src/errors.js';
import type { EventCallback } from '../src/transport.js';

class MockTransport {
  agentId = 'agent-mock';
  _eventCallback: EventCallback | null = null;
  _responses = new Map<string, Record<string, unknown>>();
  _calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  get connected() { return true; }
  onEvent(cb: EventCallback) { this._eventCallback = cb; }
  setResponse(method: string, result: Record<string, unknown>) { this._responses.set(method, result); }

  async send(method: string, params?: Record<string, unknown>) {
    this._calls.push({ method, params });
    return this._responses.get(method) ?? {};
  }

  notify() {}
  async connect() { return { status: 'connected', agent_id: this.agentId }; }
  async close() {}
}

class MockRTCTransport {
  pc = {} as RTCPeerConnection;
  cmdChannel = { readyState: 'open' } as RTCDataChannel;

  _responses = new Map<string, unknown>();
  _calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  setResponse(method: string, result: unknown) { this._responses.set(method, result); }

  async sendCommand(method: string, params?: Record<string, unknown>) {
    this._calls.push({ method, params });
    return this._responses.get(method) ?? {};
  }

  onSignaling() {}

  close() {}
}

function makeSessionWithMockRtc() {
  const mt = new MockTransport();
  const mockRtc = new MockRTCTransport();
  const sess = new Session(mt as never, 'req-1', 'incognito');
  (sess as unknown as { _active: boolean })._active = true;
  (sess as unknown as { _sessionId: string })._sessionId = 'sess-1';
  (sess as unknown as { _rtc: unknown })._rtc = mockRtc;

  (sess as unknown as { _p2pChat: unknown })._p2pChat = new P2PChatAPI(mockRtc as never);

  return { sess, mt, mockRtc };
}

describe('Session with P2P RTCTransport', () => {
  it('navigates via RTC command channel', async () => {
    const { sess, mockRtc } = makeSessionWithMockRtc();
    mockRtc.setResponse('browser.navigate', { url: 'https://example.com', title: 'Example', status: 200 });

    const result = await sess.navigate('https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.title).toBe('Example');
    expect(mockRtc._calls[0].method).toBe('browser.navigate');
  });

  it('queries DOM element via RTC', async () => {
    const { sess, mockRtc } = makeSessionWithMockRtc();
    mockRtc.setResponse('browser.query', { elements: [{ textContent: 'Hello World' }] });

    const result = await sess.query('h1');
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].textContent).toBe('Hello World');
  });

  it('throws when session is not active', async () => {
    const mt = new MockTransport();
    const sess = new Session(mt as never, 'req-1', 'incognito');

    await expect(sess.navigate('https://example.com')).rejects.toThrow(CekiBrowserError);
  });

  it('click and type send correct params via RTC', async () => {
    const { sess, mockRtc } = makeSessionWithMockRtc();
    mockRtc.setResponse('browser.click', { clicked: true });
    mockRtc.setResponse('browser.type', { typed: true });

    await sess.click('#btn');
    await sess.type('#input', 'hello');

    expect(mockRtc._calls[0]).toEqual({ method: 'browser.click', params: { selector: '#btn' } });
    expect(mockRtc._calls[1]).toEqual({
      method: 'browser.type',
      params: { selector: '#input', text: 'hello', delay_ms: 0 },
    });
  });

  it('screenshot returns result via RTC', async () => {
    const { sess, mockRtc } = makeSessionWithMockRtc();
    mockRtc.setResponse('browser.screenshot', { data: 'base64data', width: 1920, height: 1080 });

    const result = await sess.screenshot();
    expect(result.data).toBe('base64data');
    expect(result.width).toBe(1920);
  });

  it('close sends session.end via WSS and marks inactive', async () => {
    const { sess, mt } = makeSessionWithMockRtc();
    mt.setResponse('session.end', { status: 'ended' });

    await sess.close();
    expect(sess.active).toBe(false);
    expect(mt._calls[0].method).toBe('session.end');
  });

  it('chat property is available when RTC is active', () => {
    const { sess } = makeSessionWithMockRtc();
    expect(sess.chat.available).toBe(true);
  });

  it('chat property throws when RTC is not set up', () => {
    const mt = new MockTransport();
    const sess = new Session(mt as never, 'req-1', 'incognito');
    expect(() => sess.chat).toThrow(CekiBrowserError);
  });
});
