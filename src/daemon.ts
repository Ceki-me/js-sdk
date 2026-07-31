/**
 * ceki-daemon — persistent renter-process for browser.ceki.me.
 *
 * Maintains persistent WebSocket sessions to the relay, exposing them via a
 * local HTTP/JSON IPC server. CLI commands route through the daemon when it is
 * running, avoiding the one-shot disconnect → no_session cycle.
 *
 * Architecture:
 * - HTTP server (node:http, async) accepting IPC requests on 127.0.0.1:18777
 * - DaemonServer class holds persistent Client + Map<sessionId, Browser>
 * - PID file at /tmp/ceki-daemon.pid
 * - SIGTERM/SIGINT triggers graceful shutdown: close browsers + WS, remove PID
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect } from './client.js';
import type { Client } from './client.js';
import type { Browser } from './browser.js';
import { SessionNotFound } from './errors.js';

const DAEMON_HOST = '127.0.0.1';
const PID_FILE = '/tmp/ceki-daemon.pid';

/** Resolve the daemon port from env (default 18777). */
function daemonPort(): number {
  return Number.parseInt(process.env.CEKI_DAEMON_PORT ?? '18777', 10);
}

/** Load ~/.ceki/config KEY=VALUE lines into process.env (env wins). */
function loadConfig(): void {
  const configPath = path.join(os.homedir(), '.ceki', 'config');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** ConnectOptions builder — mirrors python _connect_options(). */
function connectOptions(): Partial<{ reconnect: boolean; apiUrl: string; relayUrl: string; chatUrl: string; basicAuth: [string, string] }> {
  const opts: Partial<{ reconnect: boolean; apiUrl: string; relayUrl: string; chatUrl: string; basicAuth: [string, string] }> = { reconnect: true };
  if (process.env.CEKI_API_URL) opts.apiUrl = process.env.CEKI_API_URL;
  if (process.env.CEKI_RELAY_URL) opts.relayUrl = process.env.CEKI_RELAY_URL;
  if (process.env.CEKI_CHAT_URL) opts.chatUrl = process.env.CEKI_CHAT_URL;
  if (process.env.CEKI_BASIC_AUTH_USER && process.env.CEKI_BASIC_AUTH_PASS) {
    opts.basicAuth = [process.env.CEKI_BASIC_AUTH_USER, process.env.CEKI_BASIC_AUTH_PASS];
  }
  return opts;
}

// ── Health check ──────────────────────────────────────────────────────────

/** Check if daemon is running via PID file + /health endpoint. */
export async function isRunning(port?: number): Promise<boolean> {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (pid <= 0 || Number.isNaN(pid)) {
      fs.rmSync(PID_FILE, { force: true });
      return false;
    }
    // Check if process is alive (signal 0 on Unix)
    try { process.kill(pid, 0); } catch { fs.rmSync(PID_FILE, { force: true }); return false; }
  } catch {
    fs.rmSync(PID_FILE, { force: true });
    return false;
  }
  // Verify via /health endpoint
  try {
    const health = await checkHealth(port);
    return health?.ok === true;
  } catch {
    fs.rmSync(PID_FILE, { force: true });
    return false;
  }
}

/**
 * Check if daemon is running via HTTP GET /health.
 * Used by the CLI and rent auto-start logic.
 * @param port — override port (default from env CEKI_DAEMON_PORT or 18777)
 */
export async function checkHealth(port?: number): Promise<{ ok: boolean; pid?: number } | null> {
  try {
    const p = port ?? daemonPort();
    const resp = await fetch(`http://${DAEMON_HOST}:${p}/health`);
    if (!resp.ok) return null;
    return await resp.json() as { ok: boolean; pid?: number };
  } catch {
    return null;
  }
}

// ── Endpoint dispatch ─────────────────────────────────────────────────────

type HandlerFn = (params: Record<string, unknown>) => Promise<unknown>;

const _ENDPOINTS: Record<string, string> = {
  '/rent': '_handleRent',
  '/navigate': '_handleNavigate',
  '/click': '_handleClick',
  '/type': '_handleType',
  '/scroll': '_handleScroll',
  '/switch-tab': '_handleSwitchTab',
  '/configure': '_handleConfigure',
  '/screenshot': '_handleScreenshot',
  '/snapshot': '_handleSnapshot',
  '/stop': '_handleStop',
  '/chat/send': '_handleChatSend',
  '/chat/next': '_handleChatNext',
  '/chat/history': '_handleChatHistory',
  '/cdp': '_handleCdp',
  '/profile/export': '_handleProfileExport',
  '/profile/import': '_handleProfileImport',
  '/upload': '_handleUpload',
  '/request-captcha': '_handleRequestCaptcha',
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── DaemonServer ──────────────────────────────────────────────────────────

export class DaemonServer {
  readonly host: string;
  readonly port: number;
  private _httpd: http.Server | null = null;
  /** Map<sessionId, {client, browser}> — each rent creates its own client. */
  private _sessions: Map<string, { client: Client; browser: Browser }> = new Map();

  constructor(host: string = DAEMON_HOST, port?: number) {
    this.host = host;
    this.port = port ?? daemonPort();
  }

  // ── start / stop ───────────────────────────────────────────────────────

  /** Start the HTTP server (async, resolves when listening). */
  async start(): Promise<void> {
    if (this._httpd) throw new Error('daemon already started');

    // PID file — check for stale PID
    if (fs.existsSync(PID_FILE)) {
      if (!(await isRunning(this.port))) {
        // Stale PID — clean up and continue
        try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
        process.stderr.write('daemon: removed stale PID file\n');
      } else {
        throw new Error(`already running (pid ${fs.readFileSync(PID_FILE, 'utf-8').trim()})`);
      }
    }

    return new Promise<void>((resolve, reject) => {
      this._httpd = http.createServer((req, res) => { void this._handleRequest(req, res); });

      this._httpd.on('error', (err) => reject(err));
      this._httpd.listen(this.port, this.host, () => {
        // Write PID file
        fs.writeFileSync(PID_FILE, String(process.pid));
        process.stderr.write(`daemon started — ${this.host}:${this.port} (pid ${process.pid})\n`);
        resolve();
      });
    });
  }

  /** Stop HTTP server and clean up all sessions. */
  async stop(): Promise<void> {
    process.stderr.write(`shutting down (closing ${this._sessions.size} session(s))\n`);
    // Close all browser sessions
    for (const [sessionId, entry] of this._sessions) {
      try {
        await entry.browser.close();
      } catch {
        // ignore per-session close errors
      }
    }
    this._sessions.clear();
    // Close HTTP server
    if (this._httpd) {
      await new Promise<void>((resolve) => this._httpd!.close(() => resolve()));
      this._httpd = null;
    }
    // Remove PID file
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      // ignore
    }
    process.stderr.write('daemon stopped\n');
  }

  // ── HTTP request handler ───────────────────────────────────────────────

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      const pathname = req.url?.replace(/\/+$/, '') ?? '';
      const handlerName = _ENDPOINTS[pathname];
      if (!handlerName) {
        sendJson(res, 404, { ok: false, error: `unknown endpoint: ${pathname}` });
        return;
      }

      // Read body
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', (err) => reject(err));
      });

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(body || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `invalid JSON: ${(e as Error).message}` });
        return;
      }

      // Call handler
      const handler = (this as unknown as Record<string, HandlerFn>)[handlerName];
      if (!handler) {
        sendJson(res, 500, { ok: false, error: `handler not found: ${handlerName}` });
        return;
      }

      const result = await handler.call(this, params);
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      if (e instanceof SessionNotFound) {
        sendJson(res, 404, { ok: false, error: (e as Error).message });
      } else if (e instanceof Error) {
        sendJson(res, 500, { ok: false, error: e.message });
      } else {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    }
  }

  // ── Endpoint handlers ──────────────────────────────────────────────────

  /** Resolve a Browser by session_id from stored sessions. */
  private _getBrowser(sessionId: string): Browser {
    if (!sessionId) throw new Error('session_id required');
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(`session not found: ${sessionId}`);
    return entry.browser;
  }

  /** POST /rent — rent a new browser session. */
  private async _handleRent(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const apiKey = (params.api_key as string | undefined) || process.env.CEKI_API_KEY;
    if (!apiKey) throw new Error('CEKI_API_KEY not set');
    const schedule = params.schedule;
    if (!schedule) throw new Error('schedule (int) required');
    const mode = (params.mode as string | undefined) || 'incognito';
    const fingerprintFrom = params.fingerprint_from as string | undefined;
    let fpData: boolean | Record<string, unknown> = true;
    if (fingerprintFrom) {
      const profileData = JSON.parse(fs.readFileSync(fingerprintFrom, 'utf-8'));
      fpData = (profileData as Record<string, unknown>).fingerprint as boolean | Record<string, unknown> || true;
    }

    const client = await connect(apiKey, connectOptions());
    const browser = await client.rent(Number(schedule), { mode, fingerprint: fpData } as never);
    this._sessions.set(browser.sessionId, { client, browser });
    return {
      session_id: browser.sessionId,
      chat_topic_id: browser.chatTopicId,
      schedule_id: browser.scheduleId,
    };
  }

  /** POST /navigate */
  private async _handleNavigate(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    await browser.navigate(params.url as string, undefined, { human: params.human as boolean | undefined });
  }

  /** POST /click */
  private async _handleClick(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    await browser.click(Number(params.x), Number(params.y), { human: params.human as boolean | undefined });
  }

  /** POST /type */
  private async _handleType(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    await browser.type(
      params.text as string,
      { selector: params.selector as string | undefined, human: params.human as boolean | undefined },
    );
  }

  /** POST /scroll */
  private async _handleScroll(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    const dx = params.dx as number | undefined ?? 0;
    const dy = params.dy as number | undefined ?? -300;
    await browser.scroll({
      x: Number(params.x ?? 0),
      y: Number(params.y ?? 0),
      deltaX: dx,
      deltaY: dy,
      human: params.human as boolean | undefined,
    });
  }

  /** POST /switch-tab */
  private async _handleSwitchTab(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    await browser.switchTab();
  }

  /** POST /configure */
  private async _handleConfigure(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    const opts: Record<string, boolean> = {};
    if (params.masking_mode !== undefined) opts.maskingMode = Boolean(params.masking_mode);
    if (params.fingerprint !== undefined) opts.fingerprint = Boolean(params.fingerprint);
    await browser.configure(opts as { maskingMode?: boolean; fingerprint?: boolean });
  }

  /** POST /screenshot */
  private async _handleScreenshot(params: Record<string, unknown>): Promise<Record<string, string>> {
    const browser = this._getBrowser(params.session_id as string);
    const full = Boolean(params.full ?? false);
    const fmt = (params.format as string | undefined) === 'jpeg' ? 'jpeg' : 'png';
    let data: Buffer | { data: string };
    if (fmt === 'jpeg') {
      // JPEG via _cdpFormat — returns {data: base64}
      data = await browser.screenshot({ format: 'base64', fullPage: full, _cdpFormat: 'jpeg' });
    } else {
      // PNG — returns Buffer
      data = await browser.screenshot({ format: 'png', fullPage: full });
    }
    if (data instanceof Buffer) {
      return { data: data.toString('base64') };
    }
    return { data: (data as { data: string }).data };
  }

  /** POST /snapshot */
  private async _handleSnapshot(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const browser = this._getBrowser(params.session_id as string);
    const snap = await browser.snapshot();
    return {
      screenshot: snap.screenshot,
      chat: snap.chat.map((m) => ({
        from: (m as unknown as Record<string, unknown>).sender_id,
        text: (m as unknown as Record<string, unknown>).text,
        ts: (m as unknown as Record<string, unknown>).created_at,
      })),
      ts: snap.ts.toISOString(),
    };
  }

  /** POST /stop */
  private async _handleStop(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(`session not found: ${sessionId}`);
    this._sessions.delete(sessionId);
    try {
      await entry.browser.close();
    } finally {
      try {
        await entry.client.disconnect();
      } catch {
        // ignore
      }
    }
  }

  /** POST /chat/send */
  private async _handleChatSend(params: Record<string, unknown>): Promise<Record<string, number | string | null | undefined>> {
    const browser = this._getBrowser(params.session_id as string);
    const result = await browser.chat.send(params.text as string);
    return { message_id: result.messageId };
  }

  /** POST /chat/next */
  private async _handleChatNext(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const browser = this._getBrowser(params.session_id as string);
    const timeout = Number(params.timeout ?? 60);
    const since = (params.since as string | undefined) || browser._lastSeenTs || undefined;

    const msgs = await browser.chat.history({ since, limit: 1 });
    if (msgs.length > 0) {
      const m = msgs[0] as unknown as Record<string, string>;
      browser._lastSeenTs = m.created_at;
      return { from: m.sender_id, text: m.text, ts: m.created_at };
    }

    // Wait for next message with timeout
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout * 1000);
      const handler = (msg: unknown): void => {
        clearTimeout(timer);
        const m = msg as Record<string, string>;
        browser._lastSeenTs = m.created_at;
        browser.chat.offMessage(handler);
        resolve({ from: m.sender_id, text: m.text, ts: m.created_at });
      };
      browser.chat.onMessage(handler);
    });
  }

  /** POST /chat/history */
  private async _handleChatHistory(params: Record<string, unknown>): Promise<unknown[]> {
    const browser = this._getBrowser(params.session_id as string);
    const since = params.since as string | undefined;
    const limit = Number(params.limit ?? 50);
    const msgs = await browser.chat.history({ since, limit });
    return msgs.map((m: unknown) => {
      const msg = m as Record<string, unknown>;
      return { from: msg.sender_id, text: msg.text, ts: msg.created_at };
    });
  }

  /** POST /cdp */
  private async _handleCdp(params: Record<string, unknown>): Promise<unknown> {
    const browser = this._getBrowser(params.session_id as string);
    const method = params.method as string;
    if (!method) throw new Error('method required');
    const cdpParams = (params.params as Record<string, unknown> | undefined) || {};
    return await browser.send({ method, params: cdpParams });
  }

  /** POST /profile/export */
  private async _handleProfileExport(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const browser = this._getBrowser(params.session_id as string);
    const domains = params.domains
      ? (params.domains as string).split(',').map((d: string) => d.trim())
      : undefined;
    const includeSessionStorage = !params.no_session_storage;
    return await browser.profile.export({ domains, includeSessionStorage }) as Record<string, unknown>;
  }

  /** POST /profile/import */
  private async _handleProfileImport(params: Record<string, unknown>): Promise<void> {
    const browser = this._getBrowser(params.session_id as string);
    const profile = params.profile;
    if (!profile) throw new Error('profile data required');
    await browser.profile.import(profile as Record<string, unknown>);
  }

  /** POST /upload */
  private async _handleUpload(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const browser = this._getBrowser(params.session_id as string);
    const selector = params.selector as string;
    if (!selector) throw new Error('selector required');
    const filePath = params.file_path as string;
    if (!filePath) throw new Error('file_path required');
    const filename = params.filename as string | undefined;
    const mimeType = params.mime_type as string | undefined;
    return await browser.upload(selector, filePath, filename, mimeType) as Record<string, unknown>;
  }

  /** POST /request-captcha */
  private async _handleRequestCaptcha(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const browser = this._getBrowser(params.session_id as string);
    const result = await browser.requestCaptcha({
      acceptanceTimeout: Number(params.acceptance ?? 60),
      completionTimeout: Number(params.completion ?? 120),
      autoAccept: !params.manual,
    });
    return {
      solved: result.solved,
      proof_message_id: result.proofMessageId,
      cancel_reason: result.cancelReason,
      child_event_id: result.childEventId,
      correction_id: result.correctionId,
    };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

export function main(): void {
  loadConfig(); // ~/.ceki/config → process.env

  const server = new DaemonServer();

  // Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (): Promise<void> => {
    try {
      await server.stop();
    } catch {
      // ignore shutdown errors
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  server.start().catch((err: Error) => {
    process.stderr.write(`daemon failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

// Allow running directly: node dist/daemon.js
const _daemonModulePath = fileURLToPath(import.meta.url);
const _daemonMainPath = process.argv[1];
if (_daemonMainPath && (_daemonMainPath === _daemonModulePath || _daemonMainPath.endsWith('/daemon.js'))) {
  main();
}
