import { randomUUID } from 'crypto';
import { CekiBrowserError, NoMatchError, SessionEndedError } from './errors.js';
import type { Transport, EventCallback } from './transport.js';
import { RTCTransport } from './transport-rtc.js';
import type {
  HtmlResult,
  HumanActionResult,
  NavigateResult,
  QueryResult,
  ScreenshotResult,
} from './types.js';

export class Session {
  private _transport: Transport;
  private _requestId: string;
  private _sessionId: string | null = null;
  private _mode: string;
  private _active = false;
  private _rtc: RTCTransport | null = null;
  private _iceServers: RTCIceServer[];

  constructor(
    transport: Transport,
    requestId: string,
    mode: string,
    iceServers?: RTCIceServer[],
  ) {
    this._transport = transport;
    this._requestId = requestId;
    this._mode = mode;
    this._iceServers = iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get active(): boolean {
    return this._active;
  }

  set requestId(id: string) {
    this._requestId = id;
  }

  get rtc(): RTCTransport | null {
    return this._rtc;
  }

  installMatchListener(): void {
    this._matchOriginalCb = (this._transport as unknown as { _eventCallback: EventCallback | null })._eventCallback;
    this._matchPromise = new Promise<void>((resolve, reject) => {
      this._matchResolve = resolve;
      this._matchReject = reject;
    });

    let settled = false;
    const originalCb = this._matchOriginalCb;

    const handler: EventCallback = (method, params) => {
      if (!settled) {
        if (method === 'session.matched') {
          settled = true;
          this._sessionId = (params.session_id ?? '') as string;
          this._active = true;
          this._matchResolve!();
        } else if (method === 'session.no_match') {
          settled = true;
          const reason = (params.reason ?? 'No matching providers available') as string;
          this._matchReject!(new NoMatchError(reason));
        } else if (method === 'session.ended') {
          settled = true;
          const reason = (params.reason ?? 'ended_before_active') as string;
          this._matchReject!(new SessionEndedError(reason));
        }
      }
      if (originalCb) originalCb(method, params);
    };

    this._transport.onEvent(handler);
  }

  async waitForActive(timeout = 60000): Promise<void> {
    const timer = setTimeout(() => {
      this._matchReject?.(new CekiBrowserError('Timed out waiting for session to become active'));
    }, timeout);

    try {
      await this._matchPromise;
    } finally {
      clearTimeout(timer);
      if (this._matchOriginalCb !== undefined) {
        this._transport.onEvent(this._matchOriginalCb!);
      }
    }

    await this._setupRtc();
  }

  private _matchOriginalCb: EventCallback | null | undefined;
  private _matchPromise: Promise<void> | undefined;
  private _matchResolve: (() => void) | undefined;
  private _matchReject: ((err: Error) => void) | undefined;

  async navigate(url: string, timeoutMs = 120000): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand(
      'browser.navigate',
      { url, timeout_ms: timeoutMs },
      timeoutMs + 5000,
    );
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async query(selector: string, attributes?: string[]): Promise<QueryResult> {
    this._checkActive();
    const params: Record<string, unknown> = { selector };
    if (attributes) params.attributes = attributes;
    const data = await this._rtc!.sendCommand('browser.query', params);
    return (data ?? { elements: [] }) as QueryResult;
  }

  async queryAll(selector: string, attributes?: string[], limit = 20): Promise<QueryResult> {
    this._checkActive();
    const params: Record<string, unknown> = { selector, limit };
    if (attributes) params.attributes = attributes;
    const data = await this._rtc!.sendCommand('browser.query_all', params);
    return (data ?? { elements: [] }) as QueryResult;
  }

  async getHtml(selector = 'html', outer = true): Promise<HtmlResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.get_html', { selector, outer });
    return (data ?? { html: '' }) as HtmlResult;
  }

  async click(selector?: string, x?: number, y?: number): Promise<void> {
    this._checkActive();
    const params: Record<string, unknown> = {};
    if (selector) params.selector = selector;
    if (x != null) params.x = x;
    if (y != null) params.y = y;
    await this._rtc!.sendCommand('browser.click', params);
  }

  async type(selector: string, text: string, delayMs = 0): Promise<void> {
    this._checkActive();
    await this._rtc!.sendCommand('browser.type', { selector, text, delay_ms: delayMs });
  }

  async scroll(selector?: string, direction = 'down', amount = 500): Promise<void> {
    this._checkActive();
    const params: Record<string, unknown> = {};
    if (selector) {
      params.selector = selector;
    } else {
      params.direction = direction;
      params.amount = amount;
    }
    await this._rtc!.sendCommand('browser.scroll', params);
  }

  async screenshot(format = 'png', quality = 80): Promise<ScreenshotResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.screenshot', { format, quality });
    return (data ?? { data: '', width: 0, height: 0 }) as ScreenshotResult;
  }

  async back(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.back');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async forward(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.forward');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async reload(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.reload');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async injectCredentials(secretId: string, target: Record<string, string>): Promise<Record<string, unknown>> {
    this._checkActive();
    const data = await this._rtc!.sendCommand('browser.inject_credentials', { secret_id: secretId, ...target });
    return (data ?? {}) as Record<string, unknown>;
  }

  async requestHumanAction(actionType: string, message: string, timeoutSec = 120): Promise<HumanActionResult> {
    this._checkActive();
    const data = await this._rtc!.sendCommand(
      'browser.request_human_action',
      {
        request_id: randomUUID(),
        type: actionType,
        message,
        timeout_sec: timeoutSec,
      },
      (timeoutSec + 10) * 1000,
    );
    return (data ?? { status: '', requestId: '' }) as HumanActionResult;
  }

  async close(reason = 'completed'): Promise<void> {
    if (!this._active) return;
    this._active = false;
    try {
      await this._transport.send(
        'session.end',
        { session_id: this._sessionId ?? this._requestId, reason },
        10000,
      );
    } catch {
      // best-effort
    }
    if (this._rtc) {
      this._rtc.close();
      this._rtc = null;
    }
  }

  /** Alias for {@link close} — end the browser rental. */
  async release(reason = 'completed'): Promise<void> {
    return this.close(reason);
  }

  private async _setupRtc(): Promise<void> {
    this._rtc = new RTCTransport(this._iceServers);

    this._rtc.onSignaling((method, params) => {
      this._transport.notify(method, {
        session_id: this._sessionId,
        ...params,
      });
    });

    let answerResolve: (sdp: RTCSessionDescriptionInit) => void;
    let answerReject: (err: Error) => void;
    const answerPromise = new Promise<RTCSessionDescriptionInit>((resolve, reject) => {
      answerResolve = resolve;
      answerReject = reject;
    });

    const originalCb = (this._transport as unknown as { _eventCallback: EventCallback | null })._eventCallback;
    const signalingHandler: EventCallback = (method, params) => {
      if (method === 'webrtc.answer') {
        answerResolve(params as unknown as RTCSessionDescriptionInit);
      } else if (method === 'webrtc.ice') {
        this._rtc?.addIceCandidate(params as unknown as RTCIceCandidateInit).catch(() => {});
      } else if (method === 'session.ended') {
        this._active = false;
        answerReject(new CekiBrowserError('Session ended before RTC handshake completed'));
      }
      if (originalCb) originalCb(method, params);
    };
    this._transport.onEvent(signalingHandler);

    const offer = await this._rtc.createOffer();
    this._transport.notify('webrtc.offer', {
      session_id: this._sessionId,
      sdp: offer.sdp,
      type: offer.type,
    });

    const answerTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new CekiBrowserError('Timed out waiting for WebRTC answer')), 30000);
    });

    const answer = await Promise.race([answerPromise, answerTimeout]);
    await this._rtc.applyAnswer(answer);
    await this._rtc.waitConnected(15000);

    this._installSessionEventHandler();
  }

  private _installSessionEventHandler(): void {
    const originalCb = (this._transport as unknown as { _eventCallback: EventCallback | null })._eventCallback;

    const handler: EventCallback = (method, params) => {
      if (method === 'session.ended') {
        this._active = false;
      }
      if (originalCb) originalCb(method, params);
    };

    this._transport.onEvent(handler);
  }

  private _checkActive(): void {
    if (!this._active) throw new CekiBrowserError('Session is not active');
    if (!this._rtc) throw new CekiBrowserError('P2P transport not established');
  }
}
