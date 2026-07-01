/**
 * Anti-detect probabilistic paste path in `Browser.type()` (task 4109).
 *
 * `type(text, { selector, ... })` gets two gates before it routes through the
 * real-clipboard Ctrl+V path from task 4098:
 *
 *   1. `selector` is supplied (we need a focus target for the OS paste).
 *   2. `text.length > TYPE_PASTE_MIN_CHARS` (short text has no rhythm signature).
 *   3. `Math.random() < TYPE_PASTE_PROBABILITY`.
 *
 * When any gate fails, the existing per-key `Ceki.typeText` path is used
 * verbatim. These tests pin every gate, prove the shared hotkey helper is the
 * same wire shape as `Browser.paste`, and guard the module constants against
 * future magic-number drift.
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

import { Browser, TYPE_PASTE_MIN_CHARS, TYPE_PASTE_PROBABILITY } from '../src/browser.js';
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
  vi.restoreAllMocks();
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
// Module constants
// ────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('TYPE_PASTE_MIN_CHARS and TYPE_PASTE_PROBABILITY are exported at module scope', () => {
    expect(TYPE_PASTE_MIN_CHARS).toBe(500);
    expect(TYPE_PASTE_PROBABILITY).toBe(0.625);
  });
});

// ────────────────────────────────────────────────────────────────
// Gate A — no selector → NEVER paste path
// ────────────────────────────────────────────────────────────────

describe('type() gate: selector', () => {
  it('never routes through paste path when selector is undefined, even for long text and dice=0', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const longText = 'X'.repeat(5000);
    await browser.type(longText);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0] as { method: string; params: Record<string, unknown> };
    expect(call.method).toBe('Ceki.typeText');
    expect(call.params.text).toBe(longText);
    expect(call.params.selector).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Gate B — text length
// ────────────────────────────────────────────────────────────────

describe('type() gate: text length', () => {
  it('short text with selector stays per-key even when dice=0', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await browser.type('a'.repeat(100), { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0] as { method: string; params: Record<string, unknown> };
    expect(call.method).toBe('Ceki.typeText');
    expect(call.params.selector).toBe('#in');
  });

  it('exact threshold length (500) stays per-key — strict > 500 gate', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await browser.type('a'.repeat(500), { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((sendSpy.mock.calls[0][0] as { method: string }).method).toBe('Ceki.typeText');
  });

  it('empty string with selector never routes to paste path', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await browser.type('', { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((sendSpy.mock.calls[0][0] as { method: string }).method).toBe('Ceki.typeText');
  });

  it('whitespace-only and single-char with selector stay per-key', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await browser.type('   ', { selector: '#in' });
    await browser.type('x', { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const c of sendSpy.mock.calls) {
      expect((c[0] as { method: string }).method).toBe('Ceki.typeText');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Gate C — probability
// ────────────────────────────────────────────────────────────────

describe('type() gate: probability', () => {
  it('long text with selector but dice >= 0.625 stays per-key', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    await browser.type('X'.repeat(600), { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((sendSpy.mock.calls[0][0] as { method: string }).method).toBe('Ceki.typeText');
  });

  it('dice at the boundary (== 0.625) stays per-key — strict < gate', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0.625);

    await browser.type('X'.repeat(600), { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((sendSpy.mock.calls[0][0] as { method: string }).method).toBe('Ceki.typeText');
  });
});

// ────────────────────────────────────────────────────────────────
// Paste path fires: exact 6-CDP-call sequence
// ────────────────────────────────────────────────────────────────

describe('type() paste path', () => {
  it('long text with selector + dice=0 emits the exact 4098 6-CDP-call sequence', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const longText = 'X'.repeat(600);
    await browser.type(longText, { selector: '#in' });

    expect(sendSpy).toHaveBeenCalledTimes(6);
    const calls = sendSpy.mock.calls.map(c => c[0] as { method: string; params: Record<string, unknown> });

    // No Ceki.typeText anywhere.
    for (const c of calls) {
      expect(c.method).not.toBe('Ceki.typeText');
    }

    expect(calls[0].method).toBe('Runtime.evaluate');
    const seedExpr = calls[0].params.expression as string;
    expect(seedExpr).toContain("document.createElement('textarea')");
    expect(seedExpr).toContain(JSON.stringify(longText));

    assertCtrlHotkey(calls[1], { type: 'keyDown', key: 'c', code: 'KeyC' });
    assertCtrlHotkey(calls[2], { type: 'keyUp', key: 'c', code: 'KeyC' });

    expect(calls[3].method).toBe('Runtime.evaluate');
    const cfExpr = calls[3].params.expression as string;
    expect(cfExpr).toContain('__ceki_paste_tmp__');
    expect(cfExpr).toContain('document.querySelector("#in")');
    expect(cfExpr).toContain('.focus()');

    assertCtrlHotkey(calls[4], { type: 'keyDown', key: 'v', code: 'KeyV' });
    assertCtrlHotkey(calls[5], { type: 'keyUp', key: 'v', code: 'KeyV' });
  });

  it('paste path JSON-escapes weird selector and weird text', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const nastySelector = ` #in[data-x='"a\\"b"'] `;
    const nastyText =
      'X'.repeat(600) + '\n"quotes",\n`backticks`,\\backslash,ñü';

    await browser.type(nastyText, { selector: nastySelector });

    const calls = sendSpy.mock.calls.map(c => c[0] as { params: Record<string, unknown> });

    const seedExpr = calls[0].params.expression as string;
    // Raw text with un-escaped newline must NOT appear un-escaped.
    expect(seedExpr).not.toContain(nastyText);
    expect(seedExpr).toContain(JSON.stringify(nastyText));

    const cfExpr = calls[3].params.expression as string;
    expect(cfExpr).toContain(`document.querySelector(${JSON.stringify(nastySelector)})`);
  });
});

// ────────────────────────────────────────────────────────────────
// paste() regression guard — still the 4098 wire shape
// ────────────────────────────────────────────────────────────────

describe('paste() regression after refactor into _hotkeyPasteInto', () => {
  it('emits the same 6 CDP calls in the same order', async () => {
    const sendSpy = vi.spyOn(browser, 'send').mockResolvedValue({ result: {} });

    await browser.paste('#foo', 'bar');

    expect(sendSpy).toHaveBeenCalledTimes(6);
    const calls = sendSpy.mock.calls.map(c => c[0] as { method: string; params: Record<string, unknown> });

    expect(calls[0].method).toBe('Runtime.evaluate');
    expect(calls[0].params.expression as string).toContain("document.createElement('textarea')");
    assertCtrlHotkey(calls[1], { type: 'keyDown', key: 'c', code: 'KeyC' });
    assertCtrlHotkey(calls[2], { type: 'keyUp', key: 'c', code: 'KeyC' });
    expect(calls[3].method).toBe('Runtime.evaluate');
    expect(calls[3].params.expression as string).toContain('document.querySelector("#foo")');
    assertCtrlHotkey(calls[4], { type: 'keyDown', key: 'v', code: 'KeyV' });
    assertCtrlHotkey(calls[5], { type: 'keyUp', key: 'v', code: 'KeyV' });
  });
});

// ────────────────────────────────────────────────────────────────
// Statistical sanity — dice distribution matches the constant
// ────────────────────────────────────────────────────────────────

describe('statistical sanity', () => {
  it('over 200 fixed dice values, paste-path count == count where value < 0.625', async () => {
    // 200 values in [0, 1). 125 are < 0.625, 75 are >= 0.625.
    const values = Array.from({ length: 200 }, (_, i) => i / 200);
    const expectedPaste = values.filter(v => v < TYPE_PASTE_PROBABILITY).length;
    expect(expectedPaste).toBe(125);

    let pasteHits = 0;
    let perKeyHits = 0;

    const longText = 'X'.repeat(600);

    let idx = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => values[idx++]);

    for (let i = 0; i < 200; i++) {
      const match = makeMatch();
      const b = new Browser(client, match, null);
      const sendSpy = vi.spyOn(b, 'send').mockResolvedValue({ result: {} });
      await b.type(longText, { selector: '#in' });
      if (sendSpy.mock.calls.length === 6) pasteHits++;
      else if (sendSpy.mock.calls.length === 1) perKeyHits++;
      else throw new Error(`unexpected send count ${sendSpy.mock.calls.length}`);
    }

    expect(pasteHits).toBe(expectedPaste);
    expect(perKeyHits).toBe(200 - expectedPaste);
  });
});
