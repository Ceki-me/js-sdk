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
}

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
    const msg = {
      type: 'cdp' as const,
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
      this._pendingCdp.set(id, { resolve, reject, timer });
      this._sendRaw(msg);
    });
  }

  async navigate(url: string, timeout = 30000): Promise<{ url: string; frameId?: string }> {
    if (this._humanizer) await this._humanizer.before('navigate');
    const result = await this.send({ method: 'Page.navigate', params: { url } }, timeout) as Record<string, unknown>;
    if (this._humanizer) await this._humanizer.after('navigate');
    return {
      url: String(result?.url ?? url),
      frameId: result?.frameId ? String(result.frameId) : undefined,
    };
  }

  async click(x: number, y: number): Promise<void> {
    if (this._humanizer) await this._humanizer.before('click');

    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    });
    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    });

    this._lastPointer = [x, y];

    if (this._humanizer) await this._humanizer.after('click');
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

  async type(text: string): Promise<void> {
    if (this._humanizer) {
      await this._humanizer.before('type');

      // Re-click last pointer position to focus
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

      // Type char-by-char with delays
      for (const char of text) {
        await this._sendKeystroke(char);
        const delay = this._humanizer.typeDelay();
        if (delay > 0) {
          await new Promise<void>(r => setTimeout(r, delay));
        }
      }

      await this._humanizer.after('type');
    } else {
      for (const char of text) {
        await this._sendKeystroke(char);
      }
    }
  }

  async scroll(opts?: ScrollOptions): Promise<void> {
    const x = opts?.x ?? 0;
    const y = opts?.y ?? 0;
    const deltaX = opts?.deltaX ?? 0;
    const deltaY = opts?.deltaY ?? -300;

    if (this._humanizer) await this._humanizer.before('scroll');

    await this.send({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x, y, deltaX, deltaY },
    });

    this._lastPointer = [x, y];

    if (this._humanizer) await this._humanizer.after('scroll');
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
