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
  }

  // ── request handling ────────────────────────────────────────────────────

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    const handlerName = _ENDPOINTS[url.pathname];
    if (!handlerName) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(body); } catch { /* ignore */ }
    try {
      const handler = (this as Record<string, HandlerFn>)[handlerName];
      if (!handler) throw new Error(`handler ${handlerName} not implemented`);
      const result = await handler(params);
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  // ── endpoint handlers ───────────────────────────────────────────────────

  private async _handleRent(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const apiKey = params.api_key as string;
    const schedule = params.schedule as number;
    const mode = (params.mode as 'incognito' | 'main') ?? 'incognito';
    const fingerprintFrom = params.fingerprint_from as string | undefined;

    const client = await connect(apiKey, connectOptions());
    let fpData: boolean | Record<string, unknown> = true;
    if (fingerprintFrom) {
      const profile = JSON.parse(fs.readFileSync(fingerprintFrom, 'utf-8'));
      fpData = profile.fingerprint || true;
    }
    const browser = await client.rent(schedule, { human: null, fingerprint: fpData, mode });
    this._sessions.set(browser.sessionId, { client, browser });
    return {
      session_id: browser.sessionId,
      chat_topic_id: browser.chatTopicId,
      schedule_id: browser.scheduleId,
    };
  }

  private async _handleNavigate(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const url = params.url as string;
    const human = params.human as boolean ?? true;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.navigate(url, 30000, human ? undefined : { human: false });
  }

  private async _handleClick(params: Record<string, unknown>): Promise<{ pointer: number[] }> {
    const sessionId = params.session_id as string;
    const x = params.x as number;
    const y = params.y as number;
    const human = params.human as boolean ?? true;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.click(x, y, human ? undefined : { human: false });
    return { pointer: [x, y] };
  }

  private async _handleType(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const text = params.text as string;
    const selector = params.selector as string | undefined;
    const human = params.human as boolean ?? true;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.type(text, human ? (selector ? { selector } : undefined) : { human: false });
  }

  private async _handleScroll(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const x = params.x as number;
    const y = params.y as number;
    const dy = params.dy as number;
    const human = params.human as boolean ?? true;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.scroll({ x, y, deltaY: dy, human: human ? undefined : false });
  }

  private async _handleSwitchTab(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.switchTab();
  }

  private async _handleConfigure(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const maskingMode = params.masking_mode as boolean | undefined;
    const fingerprint = params.fingerprint as boolean | undefined;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.configure({ maskingMode, fingerprint });
  }

  private async _handleScreenshot(params: Record<string, unknown>): Promise<{ data: string }> {
    const sessionId = params.session_id as string;
    const full = params.full as boolean ?? false;
    const format = (params.format as 'png' | 'jpeg') ?? 'png';
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    let data: Buffer;
    if (format === 'jpeg') {
      const result = await entry.browser.screenshot({ format: 'base64', fullPage: full, _cdpFormat: 'jpeg' });
      data = Buffer.from((result as { data: string }).data, 'base64');
    } else {
      data = await entry.browser.screenshot({ format: 'png', fullPage: full }) as Buffer;
    }
    return { data: data.toString('base64') };
  }

  private async _handleSnapshot(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params.session_id as string;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    const snap = await entry.browser.snapshot();
    const chatList = snap.chat.map((m) => ({
      from: m.sender_id,
      text: m.text,
      ts: m.created_at,
    }));
    return { screenshot: snap.screenshot, chat: chatList, ts: snap.ts.toISOString() };
  }

  private async _handleStop(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.close();
    this._sessions.delete(sessionId);
  }

  private async _handleChatSend(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const sessionId = params.session_id as string;
    const text = params.text as string;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    const result = await entry.browser.chat.send(text);
    return { message_id: result.messageId };
  }

  private async _handleChatNext(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const sessionId = params.session_id as string;
    const timeout = params.timeout as number ?? 60;
    const since = params.since as string | undefined;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    const msgs = await entry.browser.chat.history({ since });
    if (msgs.length > 0) {
      const m = msgs[0];
      return { from: m.sender_id, text: m.text, ts: m.created_at };
    }
    return null;
  }

  private async _handleChatHistory(params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const sessionId = params.session_id as string;
    const limit = params.limit as number ?? 50;
    const since = params.since as string | undefined;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    const msgs = await entry.browser.chat.history({ since, limit });
    return msgs.map((m) => ({ from: m.sender_id, text: m.text, ts: m.created_at }));
  }

  private async _handleCdp(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.session_id as string;
    const method = params.method as string;
    const cdpParams = params.params as Record<string, unknown> ?? {};
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    return await entry.browser.send({ method, params: cdpParams });
  }

  private async _handleProfileExport(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.session_id as string;
    const noSessionStorage = params.no_session_storage as boolean ?? false;
    const domains = params.domains as string | undefined;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    return await entry.browser.profile.export({
      domains: domains?.split(',').map(d => d.trim()),
      includeSessionStorage: !noSessionStorage,
    });
  }

  private async _handleProfileImport(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.session_id as string;
    const profile = params.profile as Record<string, unknown>;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    await entry.browser.profile.import(profile);
  }

  private async _handleUpload(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.session_id as string;
    const selector = params.selector as string;
    const filePath = params.file_path as string;
    const filename = params.filename as string | undefined;
    const mimeType = params.mime_type as string | undefined;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    return await entry.browser.upload(selector, filePath, filename, mimeType);
  }

  private async _handleRequestCaptcha(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params.session_id as string;
    const acceptance = params.acceptance as number ?? 60;
    const completion = params.completion as number ?? 120;
    const manual = params.manual as boolean ?? false;
    const entry = this._sessions.get(sessionId);
    if (!entry) throw new SessionNotFound(sessionId);
    const result = await entry.browser.requestCaptcha({
      acceptanceTimeout: acceptance,
      completionTimeout: completion,
      autoAccept: !manual,
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

// Daemon is started only via `ceki daemon start` command (cmdDaemon in cli.ts).
// No standalone dist/daemon.js entry point (tsup bundles daemon into cli.js).
// Auto-main guard removed — it incorrectly triggered on every CLI invocation
// because import.meta.url in the bundle points to cli.js.
