/**
 * Regression guards for `Browser.copy()` and `Browser.paste(selector, text)`.
 *
 * Both methods are pure CDP passthrough (`Runtime.evaluate` + `Input.insertText`)
 * — nothing on the extension / relay side changes. These tests pin the wire
 * shape so we don't accidentally drift into `navigator.clipboard` or the wrong
 * CDP verb.
 */
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
let browser: Browser;

beforeEach(async () => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  process.env.CEKI_HUMAN_DISABLE = '1';

  const p = Client.create('key', { reconnect: false });
  await vi.advanceTimersByTimeAsync(1);
  client = await p;

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

// ────────────────────────────────────────────────────────────────
// copy()
// ────────────────────────────────────────────────────────────────

describe('copy()', () => {
  it('sends Runtime.evaluate with window.getSelection().toString() and returns value', async () => {
    const sendSpy = vi
      .spyOn(browser, 'send')
      .mockResolvedValue({ result: { value: 'hello world' } });

    const got = await browser.copy();

    expect(got).toBe('hello world');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      method: 'Runtime.evaluate',
      params: {
        expression: 'window.getSelection().toString()',
        returnByValue: true,
      },
    });
  });

  it('returns "" when the selection is empty (no value key in result)', async () => {
    vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    expect(await browser.copy()).toBe('');
  });

  it('returns "" when result is missing entirely', async () => {
    vi.spyOn(browser, 'send').mockResolvedValue({});
    expect(await browser.copy()).toBe('');
  });

  it('returns "" verbatim when value is an empty string', async () => {
    vi.spyOn(browser, 'send').mockResolvedValue({ result: { value: '' } });
    expect(await browser.copy()).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// paste(selector, text)
// ────────────────────────────────────────────────────────────────

describe('paste(selector, text)', () => {
  it('sends Runtime.evaluate(focus) then Input.insertText in that order', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    await browser.paste('#foo', 'bar');

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector("#foo").focus()' },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      method: 'Input.insertText',
      params: { text: 'bar' },
    });
  });

  it('JSON-escapes weird selectors with quotes and backslashes', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const nasty = ` #foo[data-x='"a\\"b"'] `;
    await browser.paste(nasty, 'x');

    const expectedExpr = `document.querySelector(${JSON.stringify(nasty)}).focus()`;
    expect(sendSpy.mock.calls[0][0]).toEqual({
      method: 'Runtime.evaluate',
      params: { expression: expectedExpr },
    });
  });

  it('JSON-escapes selectors with newlines, backticks, and unicode', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const weird = "#foo\n[data-x='ñü']`";
    await browser.paste(weird, 'y');

    expect(sendSpy.mock.calls[0][0]).toEqual({
      method: 'Runtime.evaluate',
      params: { expression: `document.querySelector(${JSON.stringify(weird)}).focus()` },
    });
  });

  it('passes text to Input.insertText.text verbatim (no re-escape)', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const payload = "text with \n newlines and 'quotes' and unicode ñ";
    await browser.paste('#foo', payload);

    expect(sendSpy.mock.calls[1][0]).toEqual({
      method: 'Input.insertText',
      params: { text: payload },
    });
  });

  it('still sends Input.insertText even for empty text', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    await browser.paste('#foo', '');

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[1][0]).toEqual({
      method: 'Input.insertText',
      params: { text: '' },
    });
  });
});
