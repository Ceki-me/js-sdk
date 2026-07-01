/**
 * Regression guards for `Browser.copy()` and `Browser.paste(selector, text)`.
 *
 * Both methods drive the *OS clipboard* via synthetic Ctrl+C / Ctrl+V hotkeys
 * (`Input.dispatchKeyEvent` with `modifiers=2`). `paste` seeds arbitrary text
 * by staging it through an offscreen `<textarea>` before the Ctrl+C. Nothing
 * on the extension / relay side changes. These tests pin the wire shape so we
 * don't accidentally regress to `Input.insertText` (direct DOM insertion, not
 * the OS clipboard) or drift into `navigator.clipboard`.
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

function assertCtrlHotkey(
  call: { method: string; params: Record<string, unknown> },
  opts: { type: 'keyDown' | 'keyUp'; key: string; code: string },
): void {
  expect(call.method).toBe('Input.dispatchKeyEvent');
  const vk = opts.key.toUpperCase().charCodeAt(0);
  expect(call.params).toMatchObject({
    type: opts.type,
    modifiers: 2,
    key: opts.key,
    code: opts.code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

// ────────────────────────────────────────────────────────────────
// copy()
// ────────────────────────────────────────────────────────────────

describe('copy()', () => {
  it('reads selection via Runtime.evaluate then fires Ctrl+C', async () => {
    const sendSpy = vi
      .spyOn(browser, 'send')
      .mockResolvedValue({ result: { value: 'hello world' } });

    const got = await browser.copy();

    expect(got).toBe('hello world');
    expect(sendSpy).toHaveBeenCalledTimes(3);

    expect(sendSpy.mock.calls[0][0]).toEqual({
      method: 'Runtime.evaluate',
      params: {
        expression: 'window.getSelection().toString()',
        returnByValue: true,
      },
    });

    assertCtrlHotkey(sendSpy.mock.calls[1][0] as { method: string; params: Record<string, unknown> },
      { type: 'keyDown', key: 'c', code: 'KeyC' });
    assertCtrlHotkey(sendSpy.mock.calls[2][0] as { method: string; params: Record<string, unknown> },
      { type: 'keyUp', key: 'c', code: 'KeyC' });
  });

  it('returns "" when the selection is empty (no value key in result), still fires Ctrl+C', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    expect(await browser.copy()).toBe('');
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('returns "" when result is missing entirely', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({});
    expect(await browser.copy()).toBe('');
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('returns "" verbatim when value is an empty string', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: { value: '' } });
    expect(await browser.copy()).toBe('');
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('never calls Input.insertText (guard against 4091-era direct insertion)', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: { value: 'x' } });
    await browser.copy();
    for (const call of sendSpy.mock.calls) {
      expect((call[0] as { method: string }).method).not.toBe('Input.insertText');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// paste(selector, text)
// ────────────────────────────────────────────────────────────────

describe('paste(selector, text)', () => {
  it('runs seed textarea -> Ctrl+C -> cleanup+focus -> Ctrl+V (6 CDP calls)', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    await browser.paste('#foo', 'bar');

    expect(sendSpy).toHaveBeenCalledTimes(6);
    const calls = sendSpy.mock.calls.map(c => c[0] as { method: string; params: Record<string, unknown> });

    // 1: seed textarea
    expect(calls[0].method).toBe('Runtime.evaluate');
    const seedExpr = calls[0].params.expression as string;
    expect(seedExpr).toContain("document.createElement('textarea')");
    expect(seedExpr).toContain('position:fixed;left:-9999px');
    // text JSON-escaped ("bar" -> "\"bar\"")
    expect(seedExpr.replace(/\s+/g, '')).toContain('="bar"');

    // 2-3: Ctrl+C
    assertCtrlHotkey(calls[1], { type: 'keyDown', key: 'c', code: 'KeyC' });
    assertCtrlHotkey(calls[2], { type: 'keyUp', key: 'c', code: 'KeyC' });

    // 4: cleanup + focus
    expect(calls[3].method).toBe('Runtime.evaluate');
    const cfExpr = calls[3].params.expression as string;
    expect(cfExpr).toContain('__ceki_paste_tmp__');
    expect(cfExpr).toContain('document.querySelector("#foo")');
    expect(cfExpr).toContain('.focus()');

    // 5-6: Ctrl+V
    assertCtrlHotkey(calls[4], { type: 'keyDown', key: 'v', code: 'KeyV' });
    assertCtrlHotkey(calls[5], { type: 'keyUp', key: 'v', code: 'KeyV' });
  });

  it('never calls Input.insertText (guard against 4091-era direct insertion)', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    await browser.paste('#foo', 'bar');
    for (const call of sendSpy.mock.calls) {
      expect((call[0] as { method: string }).method).not.toBe('Input.insertText');
    }
  });

  it('JSON-escapes weird selectors with quotes and backslashes', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const nasty = ` #foo[data-x='"a\\"b"'] `;
    await browser.paste(nasty, 'x');

    const cfExpr = (sendSpy.mock.calls[3][0] as { params: Record<string, unknown> })
      .params.expression as string;
    expect(cfExpr).toContain(`document.querySelector(${JSON.stringify(nasty)})`);
  });

  it('JSON-escapes selectors with newlines, backticks, and unicode', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const weird = "#foo\n[data-x='ñü']`";
    await browser.paste(weird, 'y');

    const cfExpr = (sendSpy.mock.calls[3][0] as { params: Record<string, unknown> })
      .params.expression as string;
    expect(cfExpr).toContain(`document.querySelector(${JSON.stringify(weird)})`);
  });

  it('JSON-escapes text with quotes, newlines, backslashes, backticks, unicode', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    const payload = 'text with \n newlines, "quotes", \\backslash, `backtick`, ñü';
    await browser.paste('#foo', payload);

    const seedExpr = (sendSpy.mock.calls[0][0] as { params: Record<string, unknown> })
      .params.expression as string;
    // Raw payload must NOT appear un-escaped (contains a bare newline etc.)
    expect(seedExpr).not.toContain(payload);
    // JSON-escaped form MUST appear
    expect(seedExpr).toContain(JSON.stringify(payload));
  });

  it('empty text still runs the full 6-call hotkey dance and seeds "" into clipboard', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    await browser.paste('#foo', '');

    expect(sendSpy).toHaveBeenCalledTimes(6);
    const seedExpr = (sendSpy.mock.calls[0][0] as { params: Record<string, unknown> })
      .params.expression as string;
    expect(seedExpr.replace(/\s+/g, '')).toContain('=""');
  });
});
