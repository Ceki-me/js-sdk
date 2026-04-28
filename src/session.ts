import { randomUUID } from 'crypto';
import { ChatAPI } from './chat.js';
import { CekiBrowserError } from './errors.js';
import type { Transport, EventCallback } from './transport.js';
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
  private _chat: ChatAPI | null = null;

  constructor(transport: Transport, requestId: string, mode: string) {
    this._transport = transport;
    this._requestId = requestId;
    this._mode = mode;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get active(): boolean {
    return this._active;
  }

  get chat(): ChatAPI {
    if (!this._chat) {
      this._chat = new ChatAPI(this._transport, this._sessionId ?? this._requestId, null);
    }
    return this._chat;
  }

  async waitForActive(timeout = 60000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._transport.onEvent(originalCb!);
        reject(new CekiBrowserError('Timed out waiting for session to become active'));
      }, timeout);

      const originalCb = (this._transport as unknown as { _eventCallback: EventCallback | null })._eventCallback;

      const handler: EventCallback = (method, params) => {
        if (method === 'session.state_changed') {
          const state = params.state as string;
          const sid = (params.session_id ?? params.request_id ?? '') as string;
          if (state === 'ACTIVE') {
            this._sessionId = sid;
            this._active = true;
            this._chat = new ChatAPI(this._transport, sid, null);
            this._installChatHandler();
            clearTimeout(timer);
            resolve();
          } else if (state === 'ENDED' || state === 'ENDING') {
            clearTimeout(timer);
            this._transport.onEvent(originalCb!);
            reject(new CekiBrowserError(`Session ended with state: ${state}`));
          }
        }
        if (method === 'session.started') {
          this._sessionId = (params.session_id ?? '') as string;
          this._active = true;
          this._chat = new ChatAPI(this._transport, this._sessionId, null);
          this._installChatHandler();
          clearTimeout(timer);
          resolve();
        }
        if (originalCb) originalCb(method, params);
      };

      this._transport.onEvent(handler);
    });
  }

  async navigate(url: string, timeoutMs = 120000): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._transport.send('browser.navigate', { url, timeout_ms: timeoutMs }, timeoutMs + 5000);
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async query(selector: string, attributes?: string[]): Promise<QueryResult> {
    this._checkActive();
    const params: Record<string, unknown> = { selector };
    if (attributes) params.attributes = attributes;
    const data = await this._transport.send('browser.query', params);
    return (data ?? { elements: [] }) as QueryResult;
  }

  async queryAll(selector: string, attributes?: string[], limit = 20): Promise<QueryResult> {
    this._checkActive();
    const params: Record<string, unknown> = { selector, limit };
    if (attributes) params.attributes = attributes;
    const data = await this._transport.send('browser.query_all', params);
    return (data ?? { elements: [] }) as QueryResult;
  }

  async getHtml(selector = 'html', outer = true): Promise<HtmlResult> {
    this._checkActive();
    const data = await this._transport.send('browser.get_html', { selector, outer });
    return (data ?? { html: '' }) as HtmlResult;
  }

  async click(selector?: string, x?: number, y?: number): Promise<void> {
    this._checkActive();
    const params: Record<string, unknown> = {};
    if (selector) params.selector = selector;
    if (x != null) params.x = x;
    if (y != null) params.y = y;
    await this._transport.send('browser.click', params);
  }

  async type(selector: string, text: string, delayMs = 0): Promise<void> {
    this._checkActive();
    await this._transport.send('browser.type', { selector, text, delay_ms: delayMs });
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
    await this._transport.send('browser.scroll', params);
  }

  async screenshot(format = 'png', quality = 80): Promise<ScreenshotResult> {
    this._checkActive();
    const data = await this._transport.send('browser.screenshot', { format, quality });
    return (data ?? { data: '', width: 0, height: 0 }) as ScreenshotResult;
  }

  async back(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._transport.send('browser.back');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async forward(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._transport.send('browser.forward');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async reload(): Promise<NavigateResult> {
    this._checkActive();
    const data = await this._transport.send('browser.reload');
    return (data ?? { url: '', title: '', status: 0 }) as NavigateResult;
  }

  async injectCredentials(secretId: string, target: Record<string, string>): Promise<Record<string, unknown>> {
    this._checkActive();
    const data = await this._transport.send('browser.inject_credentials', { secret_id: secretId, ...target });
    return (data ?? {}) as Record<string, unknown>;
  }

  async requestHumanAction(actionType: string, message: string, timeoutSec = 120): Promise<HumanActionResult> {
    this._checkActive();
    const data = await this._transport.send(
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
  }

  private _installChatHandler(): void {
    const originalCb = (this._transport as unknown as { _eventCallback: EventCallback | null })._eventCallback;

    const handler: EventCallback = (method, params) => {
      if (method === 'chat.topic_created' && this._chat) {
        const topicId = params.chat_topic_id as string;
        if (topicId) this._chat._setTopicId(topicId);
      } else if (method === 'chat.message' && this._chat) {
        this._chat._dispatchMessage(params);
      } else if (method === 'chat.typing' && this._chat) {
        this._chat._dispatchTyping(params);
      }

      if (originalCb) originalCb(method, params);
    };

    this._transport.onEvent(handler);
  }

  private _checkActive(): void {
    if (!this._active) throw new CekiBrowserError('Session is not active');
  }
}
