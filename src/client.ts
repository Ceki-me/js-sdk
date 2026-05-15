import WebSocket from 'ws';
import { resolveConfig } from './config.js';
import {
  AuthError,
  SessionNotFound,
  SessionExpired,
  NotOwner,
  TimeoutError,
  SessionEnded,
  InsufficientFunds,
  RateLimitExceeded,
  ConnectionLost,
  ProviderOffline,
  CdpUnrecoverable,
  TransportError,
} from './errors.js';
import { Browser } from './browser.js';
import { Humanizer } from './humanize/humanizer.js';
import { HumanProfile } from './humanize/profile.js';
import type { ConnectOptions, BrowserOption, Match, RentOptions } from './types.js';

const BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 32, 60];
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 90000;

interface PendingRent {
  scheduleId: number;
  eventId: string | null;
  resolve: (match: Match) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  opts?: RentOptions;
}

interface PendingResume {
  sessionId: string;
  resolve: (match: Match) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  opts?: RentOptions;
}

export class Client {
  /** @internal */ _apiKey: string;
  /** @internal */ _chatUrl: string;
  /** @internal */ _basicAuth: [string, string] | undefined;
  /** @internal */ _activeBrowsers: Map<string, Browser> = new Map();

  private _ws: WebSocket | null = null;
  private _apiUrl: string;
  private _relayUrl: string;
  private _reconnect: boolean;
  private _reconnectAttempt = 0;
  private _reconnecting = false;
  private _closed = false;

  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastPongAt = 0;

  private _pendingRents: Map<string, PendingRent> = new Map(); // keyed by `rent:<scheduleId>` or eventId
  private _pendingResumes: Map<string, PendingResume> = new Map(); // keyed by sessionId

  private _connectResolve: (() => void) | null = null;
  private _connectReject: ((err: Error) => void) | null = null;

  constructor(apiKey: string, opts?: Partial<ConnectOptions>) {
    const cfg = resolveConfig(opts);
    this._apiKey = apiKey;
    this._apiUrl = cfg.apiUrl;
    this._relayUrl = cfg.relayUrl;
    this._chatUrl = cfg.chatUrl;
    this._basicAuth = cfg.basicAuth;
    this._reconnect = cfg.reconnect;
  }

  /** Factory: create client and connect */
  static async create(apiKey: string, opts?: Partial<ConnectOptions>): Promise<Client> {
    const client = new Client(apiKey, opts);
    await client._connect();
    return client;
  }

  /** @internal */
  _wsSend(msg: Record<string, unknown>): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionLost('WebSocket not connected');
    }
    this._ws.send(JSON.stringify(msg));
  }

  async search(
    filters?: Record<string, unknown>,
    limit?: number,
  ): Promise<BrowserOption[]> {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value != null) params.set(key, String(value));
      }
    }

    const url = `${this._apiUrl}/api/browsers/search?${params.toString()}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this._apiKey}`,
    };
    if (this._basicAuth) {
      const encoded = Buffer.from(`${this._basicAuth[0]}:${this._basicAuth[1]}`).toString('base64');
      headers['X-Basic-Auth'] = `Basic ${encoded}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new TransportError(`Search request failed: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.json();
    const data = (body as Record<string, unknown>).data ?? body;
    return (Array.isArray(data) ? data : []) as BrowserOption[];
  }

  async rent(scheduleId: number, opts?: RentOptions): Promise<Browser> {
    this._wsSend({ type: 'rent', browser_id: scheduleId });

    const key = `rent:${scheduleId}`;

    return new Promise<Browser>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRents.delete(key);
        reject(new TimeoutError('Rent timed out after 60s'));
      }, 60000);

      this._pendingRents.set(key, {
        scheduleId,
        eventId: null,
        opts,
        resolve: (match: Match) => {
          const humanizer = this._resolveHumanizer(opts);
          const browser = new Browser(this, match, humanizer);
          this._activeBrowsers.set(browser.sessionId, browser);
          if (opts?.maskingMode) {
            browser.configure({ maskingMode: true }).catch(() => {});
          }
          if (opts?.fingerprint) {
            browser.configure({ fingerprint: opts.fingerprint }).catch(() => {});
          }
          resolve(browser);
        },
        reject,
        timer,
      });
    });
  }

  async resume(sessionId: string, opts?: RentOptions): Promise<Browser> {
    this._wsSend({ type: 'resume', session_id: sessionId });

    return new Promise<Browser>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingResumes.delete(sessionId);
        reject(new TimeoutError('Resume timed out after 10s'));
      }, 10000);

      this._pendingResumes.set(sessionId, {
        sessionId,
        opts,
        resolve: (match: Match) => {
          const humanizer = this._resolveHumanizer(opts);
          const browser = new Browser(this, match, humanizer);
          this._activeBrowsers.set(browser.sessionId, browser);
          resolve(browser);
        },
        reject,
        timer,
      });
    });
  }

  async close(): Promise<void> {
    this._closed = true;

    // Close all active browsers
    const closePromises: Promise<void>[] = [];
    for (const browser of this._activeBrowsers.values()) {
      closePromises.push(browser.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);

    // Reject pending rents
    for (const [key, pending] of this._pendingRents) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client closed'));
    }
    this._pendingRents.clear();

    // Reject pending resumes
    for (const [key, pending] of this._pendingResumes) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client closed'));
    }
    this._pendingResumes.clear();

    this._stopHeartbeat();
    this._closeWs();
  }

  async disconnect(): Promise<void> {
    this._closed = true;
    this._activeBrowsers.clear();
    this._pendingRents.clear();
    this._pendingResumes.clear();
    this._stopHeartbeat();
    this._closeWs();
  }

  // --- Private methods ---

  private async _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._openWs();
    });
  }

  private _openWs(): void {
    const protocols = [`bearer.${this._apiKey}`];
    this._ws = new WebSocket(this._relayUrl, protocols);

    this._ws.on('open', () => {
      this._reconnectAttempt = 0;
      this._reconnecting = false;
      this._lastPongAt = Date.now();
      this._startHeartbeat();

      if (this._connectResolve) {
        this._connectResolve();
        this._connectResolve = null;
        this._connectReject = null;
      }
    });

    this._ws.on('message', (data: WebSocket.Data) => {
      this._handleMessage(data);
    });

    this._ws.on('close', (code: number, reason: Buffer) => {
      this._stopHeartbeat();
      const reasonStr = reason.toString();

      if (code === 4401 || code === 4403) {
        const err = new AuthError(reasonStr || `Auth failed (${code})`);
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject = null;
        }
        return;
      }

      if (!this._closed && this._reconnect) {
        this._scheduleReconnect();
      }
    });

    this._ws.on('error', (err: Error) => {
      if (this._connectReject) {
        this._connectReject(new TransportError(err.message));
        this._connectResolve = null;
        this._connectReject = null;
      }
    });
  }

  private _closeWs(): void {
    if (this._ws) {
      try {
        this._ws.removeAllListeners();
        this._ws.close();
      } catch {
        // ignore close errors
      }
      this._ws = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed || this._reconnecting) return;
    if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // Reject all pending operations
      const err = new ConnectionLost('Max reconnection attempts exceeded');
      this._rejectAllPending(err);
      return;
    }

    this._reconnecting = true;
    const backoffIdx = Math.min(this._reconnectAttempt, BACKOFF_SCHEDULE.length - 1);
    const delay = BACKOFF_SCHEDULE[backoffIdx] * 1000;
    this._reconnectAttempt++;

    setTimeout(() => {
      if (this._closed) return;
      this._closeWs();
      this._connectResolve = () => {
        // After reconnect, resume all active browsers
        for (const browser of this._activeBrowsers.values()) {
          this._wsSend({ type: 'resume', session_id: browser.sessionId });
        }
      };
      this._connectReject = () => {
        // Reconnect failed, try again
        this._reconnecting = false;
        this._scheduleReconnect();
      };
      this._openWs();
    }, delay);
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      try {
        this._wsSend({ type: 'ping' });
      } catch {
        // If send fails, WS close handler will trigger reconnect
      }
    }, PING_INTERVAL);

    this._pongTimer = setTimeout(() => {
      this._checkPongTimeout();
    }, PONG_TIMEOUT);
  }

  private _stopHeartbeat(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  private _checkPongTimeout(): void {
    if (this._closed) return;
    const elapsed = Date.now() - this._lastPongAt;
    if (elapsed >= PONG_TIMEOUT) {
      // Heartbeat timeout — close and reconnect
      this._closeWs();
      if (this._reconnect) {
        this._scheduleReconnect();
      }
    } else {
      // Schedule next check
      this._pongTimer = setTimeout(() => {
        this._checkPongTimeout();
      }, PONG_TIMEOUT - elapsed);
    }
  }

  private _handleMessage(data: WebSocket.Data): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(msg.type ?? '');
    const sessionId = msg.session_id ? String(msg.session_id) : null;

    switch (type) {
      case 'pong':
        this._lastPongAt = Date.now();
        break;

      case 'rent_pending':
        this._onRentPending(msg);
        break;

      case 'match':
        this._onMatch(msg);
        break;

      case 'rent.error':
        this._onRentError(msg);
        break;

      case 'resume_ok':
        this._onResumeOk(msg);
        break;

      case 'resume_failed':
        this._onResumeFailed(msg);
        break;

      case 'cdp_response':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onCdpResponse(msg);
        }
        break;

      case 'cdp_event':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onCdpEvent(msg);
        }
        break;

      case 'tab_opened':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onTabOpened(msg);
        }
        break;

      case 'session.ended':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onSessionEnded(msg);
        }
        break;

      case 'session.provider_disconnected':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onProviderDisconnected();
        }
        break;

      case 'session.provider_reconnected':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onProviderReconnected();
        }
        break;

      case 'chat.message':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onChatMessage((msg.payload ?? msg) as Record<string, unknown>);
        }
        break;

      case 'chat.read':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onChatRead((msg.payload ?? msg) as Record<string, unknown>);
        }
        break;

      case 'chat.send_ack':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onChatSendAck(msg);
        }
        break;

      case 'chat.error':
        if (sessionId) {
          const browser = this._activeBrowsers.get(sessionId);
          browser?._onChatSendError(msg);
        }
        break;

      case 'error':
        this._onError(msg);
        break;
    }
  }

  private _onRentPending(msg: Record<string, unknown>): void {
    const eventId = String(msg.event_id ?? '');
    // Update pending rent with eventId for matching
    for (const [key, pending] of this._pendingRents) {
      if (!pending.eventId) {
        pending.eventId = eventId;
        // Re-key by eventId for faster lookup on match
        this._pendingRents.delete(key);
        this._pendingRents.set(`event:${eventId}`, pending);
        break;
      }
    }
  }

  private _onMatch(msg: Record<string, unknown>): void {
    const eventId = String(msg.event_id ?? '');
    const scheduleId = Number(msg.schedule_id ?? 0);

    // Try eventId match first
    let pending = this._pendingRents.get(`event:${eventId}`);
    if (!pending) {
      // Fallback to scheduleId match
      pending = this._pendingRents.get(`rent:${scheduleId}`);
    }

    if (pending) {
      clearTimeout(pending.timer);
      const key = pending.eventId ? `event:${pending.eventId}` : `rent:${pending.scheduleId}`;
      this._pendingRents.delete(key);

      const match: Match = {
        session_id: String(msg.session_id ?? ''),
        schedule_id: scheduleId,
        event_id: eventId || null,
        chat_topic_id: msg.chat_topic_id ? String(msg.chat_topic_id) : null,
        provider_user_id: msg.provider_user_id != null ? Number(msg.provider_user_id) : null,
        started_at: Date.now(),
        browser_info: (msg.browser_info as Record<string, unknown>) ?? {},
      };

      pending.resolve(match);
    }
  }

  private _onRentError(msg: Record<string, unknown>): void {
    const eventId = String(msg.event_id ?? '');
    const code = String(msg.code ?? '');
    const message = String(msg.message ?? '');

    let pending = this._pendingRents.get(`event:${eventId}`);
    if (!pending) {
      // Try to find any pending rent
      for (const [key, p] of this._pendingRents) {
        pending = p;
        this._pendingRents.delete(key);
        break;
      }
    } else {
      this._pendingRents.delete(`event:${eventId}`);
    }

    if (pending) {
      clearTimeout(pending.timer);
      if (code === 'provider_offline') {
        pending.reject(new ProviderOffline(message));
      } else {
        pending.reject(new TransportError(message || `Rent error: ${code}`));
      }
    }
  }

  private _onResumeOk(msg: Record<string, unknown>): void {
    const sessionId = String(msg.session_id ?? '');
    const pending = this._pendingResumes.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingResumes.delete(sessionId);

    const match: Match = {
      session_id: sessionId,
      schedule_id: Number(msg.schedule_id ?? 0),
      chat_topic_id: msg.chat_topic_id ? String(msg.chat_topic_id) : null,
      provider_user_id: msg.provider_user_id != null ? Number(msg.provider_user_id) : null,
      started_at: Date.now(),
      browser_info: (msg.browser_info as Record<string, unknown>) ?? {},
    };

    pending.resolve(match);
  }

  private _onResumeFailed(msg: Record<string, unknown>): void {
    const sessionId = String(msg.session_id ?? '');
    const reason = String(msg.reason ?? '');
    const pending = this._pendingResumes.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingResumes.delete(sessionId);

    switch (reason) {
      case 'expired':
        pending.reject(new SessionExpired());
        break;
      case 'not_owner':
        pending.reject(new NotOwner());
        break;
      case 'not_found':
        pending.reject(new SessionNotFound());
        break;
      default:
        pending.reject(new SessionNotFound(reason));
    }
  }

  private _onError(msg: Record<string, unknown>): void {
    const code = Number(msg.code ?? 0);
    const reason = String(msg.reason ?? msg.message ?? '');
    const sessionId = msg.session_id ? String(msg.session_id) : null;

    // Route session-specific errors to browser
    if (sessionId) {
      const browser = this._activeBrowsers.get(sessionId);
      if (browser) {
        switch (code) {
          case -1011: // heartbeat timeout
            browser._onSessionEnded({ reason: 'heartbeat_timeout' });
            return;
          case -1012:
            browser._onError({ reason: 'insufficient_funds' });
            return;
          case -1013:
            browser._onError({ reason: 'rate_limit_exceeded' });
            return;
          case -1015: // provider_declined
            browser._onSessionEnded({ reason: 'provider_declined' });
            return;
          case -1018: // killed
            browser._onSessionEnded({ reason: 'killed' });
            return;
          case -1050:
            browser._onError({ reason: `cdp_unrecoverable: ${reason}` });
            return;
          default:
            browser._onError(msg);
            return;
        }
      }
    }

    // Global errors — reject pending operations
    switch (code) {
      case -1012: {
        const err = new InsufficientFunds(reason);
        this._rejectAllPending(err);
        break;
      }
      case -1013: {
        const err = new RateLimitExceeded(0, reason);
        this._rejectAllPending(err);
        break;
      }
    }
  }

  private _rejectAllPending(err: Error): void {
    for (const [key, pending] of this._pendingRents) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pendingRents.clear();

    for (const [key, pending] of this._pendingResumes) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pendingResumes.clear();
  }

  private _resolveHumanizer(opts?: RentOptions): Humanizer | null {
    if (process.env.CEKI_HUMAN_DISABLE === '1') return null;
    const human = opts?.human;
    if (human === null || human === undefined) {
      const envPreset = process.env.CEKI_HUMAN_PROFILE;
      const envPath = process.env.CEKI_HUMAN_PROFILE_PATH;
      if (envPath) return new Humanizer(HumanProfile.load(envPath));
      if (envPreset) return new Humanizer(HumanProfile.loadPreset(envPreset));
      return new Humanizer(HumanProfile.loadPreset('natural'));
    }
    if (human === 'natural' || human === 'careful') {
      return new Humanizer(HumanProfile.loadPreset(human));
    }
    return null;
  }
}

/** Factory function: create a connected Client */
export async function connect(apiKey: string, opts?: Partial<ConnectOptions>): Promise<Client> {
  return Client.create(apiKey, opts);
}
