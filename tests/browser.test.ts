import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { CekiBrowserError } from '../src/errors.js';
import type { EventCallback } from '../src/transport.js';

class MockTransport {
  agentId = 'agent-mock';
  _eventCallback: EventCallback | null = null;
  _responses = new Map<string, Record<string, unknown>>();
  _calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  get connected() {
    return true;
  }

  onEvent(cb: EventCallback) {
    this._eventCallback = cb;
  }

  setResponse(method: string, result: Record<string, unknown>) {
    this._responses.set(method, result);
  }

  async send(method: string, params?: Record<string, unknown>) {
    this._calls.push({ method, params });
    return this._responses.get(method) ?? {};
  }

  notify() {}
  async connect() {
    return { status: 'connected', agent_id: this.agentId };
  }
  async close() {}
}

describe('Session', () => {
  it('navigates and returns result', async () => {
    const mt = new MockTransport();
    mt.setResponse('browser.navigate', { url: 'https://example.com', title: 'Example', status: 200 });

    const sess = new Session(mt as never, 'req-1', 'incognito');
    (sess as unknown as { _active: boolean })._active = true;

    const result = await sess.navigate('https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.title).toBe('Example');
  });

  it('queries DOM element', async () => {
    const mt = new MockTransport();
    mt.setResponse('browser.query', { elements: [{ textContent: 'Hello World' }] });

    const sess = new Session(mt as never, 'req-1', 'incognito');
    (sess as unknown as { _active: boolean })._active = true;

    const result = await sess.query('h1');
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].textContent).toBe('Hello World');
  });

  it('throws when session is not active', async () => {
    const mt = new MockTransport();
    const sess = new Session(mt as never, 'req-1', 'incognito');

    await expect(sess.navigate('https://example.com')).rejects.toThrow(CekiBrowserError);
  });

  it('click and type send correct params', async () => {
    const mt = new MockTransport();
    mt.setResponse('browser.click', { clicked: true });
    mt.setResponse('browser.type', { typed: true });

    const sess = new Session(mt as never, 'req-1', 'incognito');
    (sess as unknown as { _active: boolean })._active = true;

    await sess.click('#btn');
    await sess.type('#input', 'hello');

    expect(mt._calls[0]).toEqual({ method: 'browser.click', params: { selector: '#btn' } });
    expect(mt._calls[1]).toEqual({ method: 'browser.type', params: { selector: '#input', text: 'hello', delay_ms: 0 } });
  });

  it('screenshot returns result', async () => {
    const mt = new MockTransport();
    mt.setResponse('browser.screenshot', { data: 'base64data', width: 1920, height: 1080 });

    const sess = new Session(mt as never, 'req-1', 'incognito');
    (sess as unknown as { _active: boolean })._active = true;

    const result = await sess.screenshot();
    expect(result.data).toBe('base64data');
    expect(result.width).toBe(1920);
  });

  it('close sends session.end and marks inactive', async () => {
    const mt = new MockTransport();
    mt.setResponse('session.end', { status: 'ended' });

    const sess = new Session(mt as never, 'req-1', 'incognito');
    (sess as unknown as { _active: boolean })._active = true;
    (sess as unknown as { _sessionId: string })._sessionId = 'sess-1';

    await sess.close();
    expect(sess.active).toBe(false);
  });
});
