import mime from 'mime-types';
import { TimeoutError, SessionEnded, CaptchaError, CaptchaTimeoutError } from './errors.js';
import { BrowserChat } from './chat.js';
import { BrowserProfile } from './profile.js';
import { saveSession, getLastSeenTs, updateLastSeenTs } from './state.js';
import type { Match, ScreenshotOptions, ScrollOptions, Snapshot, ChatMessage, CaptchaOptions, CaptchaResult } from './types.js';
import type { Client } from './client.js';

import { Humanizer } from './humanize/humanizer.js';
import { HumanProfile } from './humanize/profile.js';
import { keymapForChar } from './humanize/keymap.js';
export type { Humanizer, HumanProfile };

interface PendingCdp {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Transport through which this CDP was sent — for dedup with WS echo */
  _cdpTransport?: 'dc' | 'ws';
}

// task 4109 — anti-detect branching for Browser.type().
// When both gates pass, a long text-with-selector call routes through the
// real system-clipboard Ctrl+V path (from task 4098) instead of the per-key
// Ceki.typeText path. Perfect per-key rhythm on a long string is a classic
// bot signal; a paste event with inputType=insertFromPaste looks like the
// normal "user pasted from clipboard" behavior. Named constants live at
// module scope (not inside the method) so tests can pin them and future
// tuning does not leave magic numbers in two places. Exported for tests.
export const TYPE_PASTE_MIN_CHARS = 500;
export const TYPE_PASTE_PROBABILITY = 0.625;

type EventHandler = (method: string, params: Record<string, unknown>) => void;
type TabHandler = (url: string) => void;
type VoidHandler = () => void;
type UserEventHandler = (events: Record<string, unknown>[]) => void;

export class Browser {
  readonly sessionId: string;
  readonly browserId: number;
  readonly scheduleId: number;
  readonly chatTopicId: string | null;
  readonly browserInfo: Record<string, unknown>;
  readonly providerUserId: number | null;
  /** @internal */ _eventId: string | null;

  readonly chat: BrowserChat;
  readonly profile: BrowserProfile;

  /** @internal */ _client: Client;
  /** @internal */ _humanizer: Humanizer | null = null;
  /** @internal — once DC fails, stay on WS for this session */
  _p2pFallback = false;
  /** @internal */ _lastPointer: [number, number] | null = null;
  /** @internal */ _lastSeenTs: string | null = null;
  /** @internal */ _cdpCounter = 1;
  /** @internal */ _pendingCdp: Map<number, PendingCdp> = new Map();
  /** @internal */ _ended: Promise<string>;
  /** @internal */ _endedReason: string | null = null;
  /** @internal */ _resolveEnded!: (reason: string) => void;

  private _eventHandlers: EventHandler[] = [];
  private _tabHandlers: TabHandler[] = [];
  private _disconnectHandlers: VoidHandler[] = [];
  private _reconnectHandlers: VoidHandler[] = [];
  private _userEventHandlers: UserEventHandler[] = [];

  /** @internal */
  get _apiKey(): string {
    return this._client._apiKey;
  }

  /** @internal */
  get _chatUrl(): string {
    return this._client._chatUrl;
  }

  /** @internal */
  get _basicAuth(): [string, string] | undefined {
    return this._client._basicAuth;
  }

  constructor(client: Client, match: Match, humanizer?: Humanizer | null) {
    this._client = client;
    this.sessionId = match.session_id;
    this.browserId = match.schedule_id;
    this.scheduleId = match.schedule_id;
    this.chatTopicId = match.chat_topic_id ?? null;
    this.browserInfo = match.browser_info ?? {};
    this.providerUserId = match.provider_user_id ?? null;
    this._eventId = match.event_id ?? null;
    this._humanizer = humanizer ?? null;

    this.chat = new BrowserChat(this);
    this.profile = new BrowserProfile(this);

    this._ended = new Promise<string>((resolve) => {
      this._resolveEnded = resolve;
    });

    // Load last_seen_ts from state
    this._lastSeenTs = getLastSeenTs(this.sessionId);

    // Save session state
    saveSession(this.sessionId, {
      session_id: this.sessionId,
      chat_topic_id: this.chatTopicId,
      schedule_id: this.scheduleId,
      last_seen_ts: this._lastSeenTs,
    });
  }

  /** @internal — send raw message via client WS */
  _sendRaw(msg: Record<string, unknown>): void {
    this._client._wsSend(msg);
  }

  async send(
    cdp: { method: string; params?: Record<string, unknown> },
    timeout = 30000,
  ): Promise<unknown> {
    if (this._endedReason) {
      throw new SessionEnded(this._endedReason);
    }

    const id = this._cdpCounter++;
    const p2p = this._client._p2p;
    const usingDc = p2p !== null && !this._p2pFallback;

    const wsMsg: Record<string, unknown> = {
      type: 'cdp',
      session_id: this.sessionId,
      id,
      method: cdp.method,
      params: cdp.params ?? {},
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCdp.delete(id);
        reject(new TimeoutError(`CDP ${cdp.method} timed out after ${timeout}ms`));
      }, timeout);

      // Tag pending with transport for response routing (P2P screenshot race fix)
      const pending: PendingCdp = { resolve, reject, timer, _cdpTransport: usingDc ? 'dc' : 'ws' };
      this._pendingCdp.set(id, pending);

      // P2P path: wait for DC then send over DC. If DC not ready in 5s, fallback to WS.
      if (usingDc && p2p) {
        this._sendViaP2p(p2p, id, wsMsg).catch(() => {
          // Fallback already handled inside _sendViaP2p
        });
      } else {
        // WS path (fallback — used before P2P connects, when forced off,
        // or after a DC failure for this session)
        this._sendRaw(wsMsg);
      }
    });
  }

  /**
   * Attempt to send a CDP command via P2P DataChannel.
   * Falls back to WS on timeout or error.
   */
  private async _sendViaP2p(
    p2p: import('./webrtc.js').WebRTCTransport,
    id: number,
    wsMsg: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Wait for DC readiness with 5s timeout (prevents startup-race where
      // CDP goes over WS before DataChannel opens, congesting the WS and
      // starving the heartbeat ping -> false 4002 timeout).
      await Promise.race([
        p2p.waitForDcOpen(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('P2P DC timeout')), 5000)
        ),
      ]);

      // DC ready — send CDP over DataChannel
      await p2p.sendCdp({
        session_id: this.sessionId,
        id,
        method: wsMsg.method as string,
        params: wsMsg.params as Record<string, unknown>,
      });
    } catch {
      // Fallback to WS if P2P send fails (timeout or DC error)
      this._p2pFallback = true;
      const pending = this._pendingCdp.get(id);
      if (pending) {
        pending._cdpTransport = 'ws';
      }
      this._sendRaw(wsMsg);
    }
  }

  // task 427 — per-call kill-switch. human=false bypasses humanizer timings
  // AND tells the extension to skip mouse-jitter via the `_ceki_raw` marker
  // (see cdp.ts). human=true forces humanizer; human undefined = session
  // default. Global env CEKI_HUMAN_DISABLE=1 nulls this._humanizer in the
  // constructor so all paths become raw.
  private _humanizeForCall(human?: boolean): Humanizer | null {
    if (human === false) return null;
    return this._humanizer;
  }

  async navigate(url: string, timeout = 30000, opts?: { human?: boolean }): Promise<{ url: string; frameId?: string }> {
    const h = this._humanizeForCall(opts?.human);
    if (h) await h.before('navigate');
    const result = await this.send({ method: 'Page.navigate', params: { url } }, timeout) as Record<string, unknown>;
    if (h) await h.after('navigate');
    return {
      url: String(result?.url ?? url),
      frameId: result?.frameId ? String(result.frameId) : undefined,
    };
  }

  async click(x: number, y: number, opts?: { human?: boolean }): Promise<void> {
    const h = this._humanizeForCall(opts?.human);
    if (h) await h.before('click');

    const rawFlag: Record<string, unknown> = h === null ? { _ceki_raw: true } : {};
    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1, ...rawFlag },
    });
    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    });

    this._lastPointer = [x, y];

    if (h) await h.after('click');
  }

  private async _sendKeystroke(char: string): Promise<void> {
    const mapping = keymapForChar(char);
    if (!mapping) {
      await this.send({ method: 'Input.insertText', params: { text: char } });
      return;
    }
    const { code, key, vk, needsShift } = mapping;
    if (needsShift) {
      await this.send({
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
      });
    }
    await this.send({
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyDown', key, code, text: char,
        unmodifiedText: needsShift ? char.toLowerCase() : char,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        ...(needsShift ? { modifiers: 8 } : {}),
      },
    });
    await this.send({
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyUp', key, code,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        ...(needsShift ? { modifiers: 8 } : {}),
      },
    });
    if (needsShift) {
      await this.send({
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
      });
    }
  }

  async type(text: string, opts?: { human?: boolean; selector?: string }): Promise<void> {
    // task 413 — typing humanizer moved into the extension. The SDK now
    // sends ONE Ceki.typeText command instead of N per-char dispatchKey
    // events, so long inputs no longer burn through the 500 cmd / 60s
    // relay cap and the inter-key delays land without WS jitter.
    //
    // task 4109 — anti-detect branching. For LONG text delivered into a
    // KNOWN selector, roll the dice against TYPE_PASTE_PROBABILITY and (if
    // the gate opens) route through the real-clipboard Ctrl+V path from
    // task 4098 instead of Ceki.typeText. Reasons this branch is gated on
    // both `selector` and length:
    //   - no selector => we don't know where to focus for the OS paste,
    //     so the per-char path (which types into current focus) is the
    //     only sane fallback;
    //   - short text has no rhythm-signature problem to begin with, and
    //     paste-events on short strings look weirder than per-key ones.
    // Humanizer before/after hooks still run around the paste path.
    const selector = opts?.selector;
    if (
      selector !== undefined
      && text.length > TYPE_PASTE_MIN_CHARS
      && Math.random() < TYPE_PASTE_PROBABILITY
    ) {
      const hPre = this._humanizeForCall(opts?.human);
      if (hPre) await hPre.before('type');
      await this._hotkeyPasteInto(selector, text);
      if (hPre) await hPre.after('type');
      return;
    }

    const h = this._humanizeForCall(opts?.human);
    if (h) {
      await h.before('type');

      // Re-click last pointer position to focus (kept on the SDK side so
      // pre-focus stays exactly as before; this is one command, not N).
      if (this._lastPointer) {
        const [px, py] = this._lastPointer;
        await this.send({
          method: 'Input.dispatchMouseEvent',
          params: { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 },
        });
        await this.send({
          method: 'Input.dispatchMouseEvent',
          params: { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 },
        });
      }
    }

    const human = h
      ? (['natural', 'careful'].includes(h.profile.name) ? h.profile.name : 'natural')
      : null;
    const params: Record<string, unknown> = { text, human };
    if (selector !== undefined) params.selector = selector;
    await this.send({ method: 'Ceki.typeText', params });

    if (h) {
      await h.after('type');
    }
  }

  async scroll(opts?: ScrollOptions & { human?: boolean }): Promise<void> {
    const x = opts?.x ?? 0;
    const y = opts?.y ?? 0;
    const deltaX = opts?.deltaX ?? 0;
    const deltaY = opts?.deltaY ?? -300;

    const h = this._humanizeForCall(opts?.human);
    if (h) await h.before('scroll');

    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x, y, deltaX, deltaY },
    });

    this._lastPointer = [x, y];

    if (h) await h.after('scroll');
  }

  async screenshot(opts?: ScreenshotOptions): Promise<{ data: string } | Buffer> {
    const format = opts?.format ?? 'base64';
    const fullPage = opts?.fullPage ?? false;

    let clip: Record<string, unknown> | undefined;

    if (fullPage) {
      const metrics = await this.send({ method: 'Page.getLayoutMetrics' }) as Record<string, unknown>;
      const contentSize = metrics?.contentSize as Record<string, unknown> | undefined;
      if (contentSize) {
        const width = Number(contentSize.width ?? 1920);
        const height = Math.min(Number(contentSize.height ?? 1080), 16384);
        clip = { x: 0, y: 0, width, height, scale: 1 };
      }
    }

    const params: Record<string, unknown> = { format: 'png' };
    if (clip) params.clip = clip;

    const result = await this.send({ method: 'Page.captureScreenshot', params }) as Record<string, unknown>;
    const data = String(result?.data ?? '');

    if (format === 'png') {
      return Buffer.from(data, 'base64');
    }

    return { data };
  }

  async snapshot(): Promise<Snapshot> {
    const [ssResult, chatMessages] = await Promise.all([
      this.screenshot({ format: 'base64' }),
      this.chat.history({ since: this._lastSeenTs ?? undefined }),
    ]);

    const screenshotData = (ssResult as { data: string }).data;

    if (chatMessages.length > 0) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      this._lastSeenTs = lastMsg.created_at;
      updateLastSeenTs(this.sessionId, this._lastSeenTs);
    }

    return {
      screenshot: screenshotData,
      chat: chatMessages,
      ts: new Date(),
    };
  }

  private static _detectMime(filename: string): string {
    return mime.lookup(filename) || 'application/octet-stream';
  }

  async upload(
    selector: string,
    source: string | Buffer,
    filename?: string,
    mime?: string,
  ): Promise<{ ok: boolean; filename: string; size: number }> {
    let buf: Buffer;
    let resolvedFilename: string;

    if (typeof source === 'string') {
      const fs = await import('node:fs');
      const path = await import('node:path');
      buf = fs.readFileSync(source);
      resolvedFilename = filename ?? path.basename(source);
    } else {
      buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
      resolvedFilename = filename ?? 'file';
    }

    const mimeType = mime ?? Browser._detectMime(resolvedFilename);
    console.info(`upload: file=${resolvedFilename} mime=${mimeType} size=${buf.length}`);

    const b64 = buf.toString('base64');
    const size = buf.length;

    const expression = `
      (function() {
        var input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return JSON.stringify({ok: false, error: 'Element not found'});
        var b64 = ${JSON.stringify(b64)};
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var file = new File([bytes], ${JSON.stringify(resolvedFilename)}, {type: ${JSON.stringify(mimeType)}});
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', {bubbles: true}));
        return JSON.stringify({ok: true, filename: ${JSON.stringify(resolvedFilename)}, size: ${size}});
      })()
    `.trim();

    const result = await this.send({
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }) as Record<string, unknown>;

    const resultObj = result?.result as Record<string, unknown> | undefined;

    try {
      await this.send({
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      });
      await this.send({
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      });
    } catch {
      // ignore — best-effort dialog dismiss
    }

    if (resultObj?.value) {
      return JSON.parse(String(resultObj.value)) as { ok: boolean; filename: string; size: number };
    }
    return { ok: true, filename: resolvedFilename, size };
  }

  /**
   * Dispatch a `Ctrl+<key>` hotkey as `keyDown`+`keyUp` via CDP.
   *
   * `modifiers=2` is Chromium's bitmask for Control. Both `keyDown` and `keyUp`
   * are required because the browser's clipboard shortcuts only trigger on a
   * full press cycle. Shared by `copy()` (Ctrl+C) and `paste()` (Ctrl+C on the
   * seed textarea, Ctrl+V on the target).
   */
  private async _dispatchHotkey(key: string, code: string): Promise<void> {
    const vk = key.toUpperCase().charCodeAt(0);
    const base = {
      modifiers: 2,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    };
    await this.send({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', ...base },
    });
    await this.send({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', ...base },
    });
  }

  /**
   * Copy the current window selection into the OS clipboard, return it.
   *
   * Reads the selection via `Runtime.evaluate` (`window.getSelection().toString()`)
   * so the caller still gets a return value, then dispatches a synthetic
   * `Ctrl+C` via `Input.dispatchKeyEvent` — that is the step that actually
   * flips the OS clipboard. Verified against real headed Chromium in contract
   * task 4098.
   *
   * We read the selection before Ctrl+C rather than reading it back from the
   * clipboard because the main-mode CDP allowlist forbids `navigator.clipboard`
   * and `document.execCommand('paste')` is dead in modern Chromium, so no JS
   * read-back path exists. Reading the selection directly is cheap and exact.
   *
   * @returns The selection text (`""` when nothing is selected). The OS
   * clipboard is flipped as a side effect regardless of the return.
   */
  async copy(): Promise<string> {
    const res = await this.send({
      method: 'Runtime.evaluate',
      params: { expression: 'window.getSelection().toString()', returnByValue: true },
    }) as Record<string, unknown>;
    const resultObj = res?.result as Record<string, unknown> | undefined;
    const v = resultObj?.value;
    const selection = typeof v === 'string' ? v : '';
    await this._dispatchHotkey('c', 'KeyC');
    return selection;
  }

  /**
   * Put `text` into the OS clipboard, focus `selector`, then Ctrl+V it in.
   *
   * Real system-clipboard paste: a temporary offscreen `<textarea>` is created
   * and selected, then a synthetic `Ctrl+C` flips the OS clipboard to `text`.
   * The temp element is removed, the target element is focused, and a synthetic
   * `Ctrl+V` fires — which dispatches a real `ClipboardEvent` (the `paste`
   * handler plus an `input` event with `inputType='insertFromPaste'`).
   * Verified against real headed Chromium in contract task 4098.
   *
   * Both `selector` and `text` are JSON-escaped when interpolated into the
   * `Runtime.evaluate` expression — quotes, backticks, backslashes, newlines,
   * and unicode are safe.
   *
   * @param selector CSS selector for the target input / textarea /
   *   contentEditable / any focusable element.
   * @param text Arbitrary string to paste. Empty string is allowed; it seeds
   *   an empty clipboard and Ctrl+V still fires the `paste` event.
   */
  /**
   * Real system-clipboard paste of `text` into `selector`.
   *
   * Shared 6-CDP-call sequence (from task 4098):
   *   1. Runtime.evaluate — build offscreen `<textarea>`, set value, focus+select
   *   2. Input.dispatchKeyEvent keyDown `c` (Ctrl+C — flips OS clipboard)
   *   3. Input.dispatchKeyEvent keyUp   `c`
   *   4. Runtime.evaluate — remove temp element, focus target selector
   *   5. Input.dispatchKeyEvent keyDown `v` (Ctrl+V — fires paste event)
   *   6. Input.dispatchKeyEvent keyUp   `v`
   *
   * Both `selector` and `text` are JSON-escaped when interpolated — quotes,
   * backticks, backslashes, newlines, and unicode are safe.
   *
   * Called by {@link paste} (public API) and {@link type} (task 4109
   * anti-detect branch for long text). Extracting keeps the two callers
   * wire-identical.
   */
  private async _hotkeyPasteInto(selector: string, text: string): Promise<void> {
    const textLit = JSON.stringify(text);
    const seedExpr =
      "(function(){" +
      "var __ceki_tmp__=document.createElement('textarea');" +
      "__ceki_tmp__.id='__ceki_paste_tmp__';" +
      "__ceki_tmp__.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';" +
      `__ceki_tmp__.value=${textLit};` +
      "document.body.appendChild(__ceki_tmp__);" +
      "__ceki_tmp__.focus();__ceki_tmp__.select();" +
      "})()";
    await this.send({
      method: 'Runtime.evaluate',
      params: { expression: seedExpr },
    });
    await this._dispatchHotkey('c', 'KeyC');

    const selectorLit = JSON.stringify(selector);
    const cleanupFocusExpr =
      "(function(){" +
      "var t=document.getElementById('__ceki_paste_tmp__');" +
      "if(t)t.remove();" +
      `var el=document.querySelector(${selectorLit});` +
      "el.focus();" +
      "})()";
    await this.send({
      method: 'Runtime.evaluate',
      params: { expression: cleanupFocusExpr },
    });
    await this._dispatchHotkey('v', 'KeyV');
  }

  async paste(selector: string, text: string): Promise<void> {
    await this._hotkeyPasteInto(selector, text);
  }

  async switchTab(): Promise<void> {
    this._sendRaw({ type: 'switch_tab', session_id: this.sessionId });
  }

  async configure(opts: { maskingMode?: boolean; fingerprint?: boolean | Record<string, unknown> }): Promise<void> {
    const msg: Record<string, unknown> = {
      type: 'session.configure',
      session_id: this.sessionId,
    };
    if (opts.maskingMode !== undefined) msg.masking_mode = opts.maskingMode;
    if (opts.fingerprint !== undefined) msg.fingerprint = opts.fingerprint;
    this._sendRaw(msg);
  }

  async close(timeout = 10000): Promise<void> {
    if (this._endedReason) return;

    this._sendRaw({
      type: 'session.end',
      session_id: this.sessionId,
      reason: 'user_stop',
    });

    await Promise.race([
      this._ended,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new TimeoutError('Close timed out')), timeout)
      ),
    ]).catch(() => {
      // If timed out, force cleanup
    });

    this._cleanup();
  }

  async release(timeout?: number): Promise<void> {
    return this.close(timeout);
  }

  async waitUntilEnded(): Promise<string> {
    return this._ended;
  }

  onEvent(cb: EventHandler): void {
    this._eventHandlers.push(cb);
  }

  onTabOpened(cb: TabHandler): void {
    this._tabHandlers.push(cb);
  }

  onProviderDisconnected(cb: VoidHandler): void {
    this._disconnectHandlers.push(cb);
  }

  onProviderReconnected(cb: VoidHandler): void {
    this._reconnectHandlers.push(cb);
  }

  onUserEvent(cb: UserEventHandler): void {
    this._userEventHandlers.push(cb);
  }

  // --- Captcha / human action ---

  private _apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
    };
    const basicAuth = this._basicAuth;
    if (basicAuth) {
      const encoded = Buffer.from(`${basicAuth[0]}:${basicAuth[1]}`).toString('base64');
      headers['X-Basic-Auth'] = `Basic ${encoded}`;
    }
    return headers;
  }

  async requestCaptcha(opts?: CaptchaOptions): Promise<CaptchaResult> {
    let acceptanceTimeout = opts?.acceptanceTimeout ?? 60;
    let completionTimeout = opts?.completionTimeout ?? 120;
    const autoAccept = opts?.autoAccept ?? true;

    if (acceptanceTimeout < 30) throw new Error('acceptanceTimeout must be >= 30 seconds');
    if (completionTimeout < 30) throw new Error('completionTimeout must be >= 30 seconds');

    acceptanceTimeout = Math.min(acceptanceTimeout, 300);
    completionTimeout = Math.min(completionTimeout, 600);

    const { id: childEventId } = await this._createCaptchaEvent(acceptanceTimeout, completionTimeout);
    const completionDeadline = Date.now() + completionTimeout * 1000;

    const buffer: Record<string, unknown>[] = [];
    let waiter: ((action: Record<string, unknown>) => void) | null = null;

    this.chat._actionCallbacks.set(childEventId, (action) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(action);
      } else {
        buffer.push(action);
      }
    });

    const nextAction = (timeoutMs: number): Promise<Record<string, unknown>> => {
      if (buffer.length > 0) return Promise.resolve(buffer.shift()!);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error('timeout'));
        }, timeoutMs);
        waiter = (action) => {
          clearTimeout(timer);
          resolve(action);
        };
      });
    };

    const cleanup = () => {
      this.chat._actionCallbacks.delete(childEventId);
      waiter = null;
    };

    const makeResult = async (
      data: Record<string, unknown>,
      solved: boolean,
    ): Promise<CaptchaResult> => {
      const correctionId = data.correction_id != null ? Number(data.correction_id) : null;
      const proofMessageId = data.proof_message_id != null ? String(data.proof_message_id) : null;
      let voted = false;

      const result: CaptchaResult = {
        solved,
        proofMessageId,
        cancelReason: null,
        childEventId,
        correctionId,
        acceptWork: async () => {
          if (voted) return;
          if (!correctionId) throw new CaptchaError('no correction_id — provider has not proposed completion');
          voted = true;
          await fetch(`${this._client._apiUrl}/api/agent/kal/event/${childEventId}/vote`, {
            method: 'POST',
            headers: this._apiHeaders(),
            body: JSON.stringify({ ids: [correctionId], vote: true }),
          });
        },
        rejectWork: async (reason?: string) => {
          if (voted) return;
          if (!correctionId) throw new CaptchaError('no correction_id — provider has not proposed completion');
          voted = true;
          const body: Record<string, unknown> = { ids: [correctionId], vote: false };
          if (reason) body.reason = reason;
          await fetch(`${this._client._apiUrl}/api/agent/kal/event/${childEventId}/vote`, {
            method: 'POST',
            headers: this._apiHeaders(),
            body: JSON.stringify(body),
          });
        },
      };

      if (autoAccept && solved && correctionId) {
        await new Promise<void>(r => setTimeout(r, 2000));
        await result.acceptWork();
      }

      return result;
    };

    let accepted = false;

    try {
      // Phase 1: wait for acceptance
      const acceptDeadline = Date.now() + acceptanceTimeout * 1000;
      while (true) {
        const remaining = acceptDeadline - Date.now();
        if (remaining <= 0) throw new Error('timeout');
        const action = await nextAction(remaining);
        const kind = String(action.kind ?? '');
        const data = (action.data ?? {}) as Record<string, unknown>;

        if (kind === 'human_action_accepted') {
          accepted = true;
          break;
        }
        if (kind === 'human_action_completed') {
          cleanup();
          return await makeResult(data, true);
        }
        if (kind === 'human_action_failed' || kind === 'human_action_declined' || kind === 'human_action_withdrew') {
          cleanup();
          return {
            solved: false,
            proofMessageId: null,
            cancelReason: kind.replace('human_action_', ''),
            childEventId,
            correctionId: null,
            acceptWork: async () => {},
            rejectWork: async () => {},
          };
        }
      }

      // Phase 2: wait for completion
      while (true) {
        const remaining = completionDeadline - Date.now();
        if (remaining <= 0) throw new Error('timeout');
        const action = await nextAction(remaining);
        const kind = String(action.kind ?? '');
        const data = (action.data ?? {}) as Record<string, unknown>;

        if (kind === 'human_action_completed') {
          cleanup();
          return await makeResult(data, true);
        }
        if (kind === 'human_action_failed' || kind === 'human_action_withdrew') {
          cleanup();
          return {
            solved: false,
            proofMessageId: null,
            cancelReason: kind.replace('human_action_', ''),
            childEventId,
            correctionId: null,
            acceptWork: async () => {},
            rejectWork: async () => {},
          };
        }
      }
    } catch {
      cleanup();
      const phase = accepted ? 'completion' : 'acceptance';
      await this._expireCaptchaEvent(childEventId);
      throw new CaptchaTimeoutError(phase);
    }
  }

  private async _createCaptchaEvent(acceptanceTimeout: number, completionTimeout: number): Promise<{ id: number; amount: number }> {
    const body = {
      acceptance_deadline_at: Math.floor(acceptanceTimeout),
      completion_deadline_at: Math.floor(completionTimeout),
    };

    const resp = await fetch(`${this._client._apiUrl}/api/agent/sessions/${this._eventId}/captcha-request`, {
      method: 'POST',
      headers: this._apiHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Captcha request failed: ${resp.status}`);
    }
    const result = await resp.json() as { id: number; amount: number };
    if (!result.id) throw new Error('Captcha request did not return an id');
    return { id: result.id, amount: result.amount };
  }

  private async _expireCaptchaEvent(childEventId: number): Promise<void> {
    try {
      await fetch(`${this._client._apiUrl}/api/agent/kal/event/${childEventId}`, {
        method: 'PATCH',
        headers: this._apiHeaders(),
        body: JSON.stringify({ status_id: 777 }),
      });
    } catch { /* best effort */ }
  }

  // --- Internal handlers called by Client dispatch ---

  /** @internal */
  _onCdpResponse(msg: Record<string, unknown>): void {
    const id = Number(msg.id);
    const pending = this._pendingCdp.get(id);
    if (!pending) return;

    // P2P screenshot race fix: when a command was sent via DC (ceki-cmd data
    // channel), the relay also echoes a WS cdp_response that races ahead
    // but has empty result for large payloads (screenshot). Skip the WS echo
    // and wait for the DC response with full data.
    const transport = pending._cdpTransport ?? 'ws';
    const isFromWs = String(msg.type) === 'cdp_response' || msg.session_id != null;
    if (transport === 'dc' && isFromWs) {
      return;
    }

    clearTimeout(pending.timer);
    this._pendingCdp.delete(id);

    if (msg.ok === false) {
      const error = msg.error as Record<string, unknown> | undefined;
      pending.reject(new Error(String(error?.message ?? error?.code ?? 'CDP error')));
    } else {
      pending.resolve(msg.result ?? null);
    }
  }

  /** @internal */
  _onCdpEvent(msg: Record<string, unknown>): void {
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Record<string, unknown>;
    for (const h of this._eventHandlers) {
      try {
        h(method, params);
      } catch {
        // handler errors should not break dispatch
      }
    }
  }

  /** @internal */
  _onTabOpened(msg: Record<string, unknown>): void {
    const url = String(msg.url ?? '');
    for (const h of this._tabHandlers) {
      try {
        h(url);
      } catch {
        // handler errors should not break dispatch
      }
    }
  }

  /** @internal */
  _onSessionEnded(msg: Record<string, unknown>): void {
    const reason = String(msg.reason ?? 'unknown');
    this._endedReason = reason;
    this._resolveEnded(reason);
    this._rejectAllPending(new SessionEnded(reason));
    this._cleanup();
  }

  /** @internal */
  _onProviderDisconnected(): void {
    for (const h of this._disconnectHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }

  /** @internal */
  _onProviderReconnected(): void {
    for (const h of this._reconnectHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }

  /** @internal */
  _onError(msg: Record<string, unknown>): void {
    const reason = String(msg.reason ?? msg.message ?? 'unknown error');
    this._endedReason = reason;
    this._resolveEnded(reason);
    this._rejectAllPending(new SessionEnded(reason));
    this._cleanup();
  }

  /** @internal */
  _onUserEvents(msg: Record<string, unknown>): void {
    const events = (msg.events ?? []) as Record<string, unknown>[];
    for (const h of this._userEventHandlers) {
      try { h(events); } catch { /* ignore */ }
    }
  }

  /** @internal */
  _onChatMessage(payload: Record<string, unknown>): void {
    this.chat._onMessage(payload);
  }

  /** @internal */
  _onChatRead(payload: Record<string, unknown>): void {
    this.chat._onRead(payload);
  }

  /** @internal */
  _onChatSendAck(msg: Record<string, unknown>): void {
    this.chat._onSendAck(msg);
  }

  /** @internal */
  _onChatSendError(msg: Record<string, unknown>): void {
    this.chat._onSendError(msg);
  }

  private _rejectAllPending(err: Error): void {
    for (const [id, pending] of this._pendingCdp) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pendingCdp.clear();
  }

  private _cleanup(): void {
    this._client._activeBrowsers.delete(this.sessionId);
  }
}
