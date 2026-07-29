#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connect } from './client.js';
import {
  CekiBrowserError,
  AuthError,
  CaptchaTimeoutError,
  SessionNotFound,
  SessionExpired,
  NotOwner,
  TimeoutError,
  ConnectionLost,
  TransportError,
} from './errors.js';
import { saveSession, loadSession, deleteSession, getLastSeenTs, updateLastSeenTs } from './state.js';
import type { ConnectOptions, ChatMessage } from './types.js';
import type { Client } from './client.js';
import type { Browser } from './browser.js';
import { cmdContract, cmdHire, cmdTimelog } from './contract-cli.js';
import { DaemonServer, checkHealth, isRunning } from './daemon.js';
import { spawn } from 'node:child_process';

/** Load ~/.ceki/config KEY=VALUE lines into process.env (env wins). Silently skip if missing. */
function loadConfig(): void {
  const configPath = path.join(os.homedir(), '.ceki', 'config');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return; // silently skip if file doesn't exist or can't be read
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // env wins: only set if not already defined
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function err(error: string, code = 'error'): void {
  process.stderr.write(JSON.stringify({ error, code }) + '\n');
}

function getApiKey(): string {
  const key = process.env.CEKI_API_KEY;
  if (!key) {
    err('CEKI_API_KEY not set', 'auth');
    process.exit(2);
  }
  return key;
}

function connectOptions(): Partial<ConnectOptions> {
  return { reconnect: false };
}

async function resumeBrowser(apiKey: string, sessionId: string): Promise<[Client, Browser]> {
  const client = await connect(apiKey, connectOptions());
  const browser = await client.resume(sessionId, { human: null });
  return [client, browser];
}

async function closeClient(client: Client): Promise<void> {
  try { await client.disconnect(); } catch { /* ignore */ }
}

/**
 * Send a request to the daemon IPC. Caller MUST check isRunning() first.
 * Throws on daemon error, returns the result data (null for void handlers).
 */
async function _daemonRequest(path: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
  const port = Number.parseInt(process.env.CEKI_DAEMON_PORT ?? '18777', 10);
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await resp.json() as { ok: boolean; result?: unknown; error?: string };
  if (!data.ok) throw new Error(data.error ?? 'daemon error');
  return data.result ?? null;
}

function parseBool(val: string): boolean {
  return val === 'true' || val === '1' || val === 'yes';
}

// --- Command handlers ---

async function cmdRent(args: string[]): Promise<void> {
  let scheduleId: number | null = null;
  let fingerprintFrom: string | null = null;
  let mode: 'incognito' | 'main' = 'incognito';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--schedule' && args[i + 1]) scheduleId = parseInt(args[++i], 10);
    if (args[i] === '--fingerprint-from' && args[i + 1]) fingerprintFrom = args[++i];
    if (args[i] === '--mode' && args[i + 1]) {
      const v = args[++i];
      if (v !== 'incognito' && v !== 'main') {
        err('invalid mode, must be incognito or main', 'args');
        process.exit(1);
      }
      mode = v;
    }
  }
  if (scheduleId == null) {
    err('--schedule is required', 'args');
    process.exit(1);
  }

  const apiKey = getApiKey();

  // Auto-start daemon if CEKI_DAEMON_AUTOSTART=1 (python parity)
  if (process.env.CEKI_DAEMON_AUTOSTART === '1' || process.env.CEKI_DAEMON_AUTOSTART === 'true') {
    if (!(await isRunning())) {
      const child = spawn(process.argv[0], [process.argv[1], 'daemon', 'start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      // Poll until daemon is ready (up to 5s, python parity)
      const deadline = Date.now() + 5000;
      let ready = false;
      while (Date.now() < deadline) {
        if (await isRunning()) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!ready) {
        err('daemon did not start in time', 'daemon');
        process.exit(1);
      }
    }
    // Route through daemon
    try {
      const rentParams: Record<string, unknown> = { api_key: apiKey, schedule: scheduleId, mode };
      if (fingerprintFrom) rentParams.fingerprint_from = fingerprintFrom;
      const result = await _daemonRequest('/rent', rentParams) as Record<string, unknown>;
      saveSession(result.session_id as string, {
        session_id: result.session_id as string,
        chat_topic_id: result.chat_topic_id as string | null,
        schedule_id: result.schedule_id as number,
        last_seen_ts: null,
      });
      out({
        session_id: result.session_id,
        chat_topic_id: result.chat_topic_id,
        schedule_id: result.schedule_id,
      });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }

  // One-shot rent (no daemon)
  let fpData: boolean | Record<string, unknown> = true;
  if (fingerprintFrom) {
    const profile = JSON.parse(fs.readFileSync(fingerprintFrom, 'utf-8'));
    fpData = profile.fingerprint || true;
  }

  const client = await connect(apiKey, connectOptions());
  try {
    const browser = await client.rent(scheduleId, { human: null, fingerprint: fpData, mode });
    saveSession(browser.sessionId, {
      session_id: browser.sessionId,
      chat_topic_id: browser.chatTopicId,
      schedule_id: browser.scheduleId,
      last_seen_ts: null,
    });
    out({
      session_id: browser.sessionId,
      chat_topic_id: browser.chatTopicId,
      schedule_id: browser.scheduleId,
    });
  } finally {
    await closeClient(client);
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  let limit = 20;
  const filters: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    if (args[i] === '--filter' && args[i + 1]) {
      const [k, ...v] = args[++i].split('=');
      filters[k] = v.join('=');
    }
  }

  const apiKey = getApiKey();
  const client = await connect(apiKey, connectOptions());
  try {
    const results = await client.search(filters, limit);
    out(results);
  } finally {
    await closeClient(client);
  }
}

async function cmdSessions(args: string[]): Promise<void> {
  let showAll = false;
  let limit = 50;
  let jsonOutput = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') showAll = true;
    else if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
  }
  const apiKey = getApiKey();
  const client = await connect(apiKey, connectOptions());
  try {
    const results = await client.listSessions({ active: !showAll, limit });
    if (jsonOutput) {
      out(results);
    } else {
      if (!results.length) {
        process.stdout.write('No sessions found.\n');
        return;
      }
      const header = 'SID'.padEnd(8) + 'SCHEDULE'.padEnd(10) + 'STARTED'.padEnd(22) + 'DURATION'.padEnd(10) + 'EARNED'.padEnd(9) + 'STATUS'.padEnd(10) + 'RENTER'.padEnd(16) + 'PROVIDER';
      process.stdout.write(header + '\n');
      for (const s of results) {
        const started = s.started_at ?? '—';
        const mins = Math.floor(s.duration / 60);
        const secs = s.duration % 60;
        const dur = `${mins}:${String(secs).padStart(2, '0')}`;
        const earned = `$${s.earned.toFixed(2)}`;
        const renter = (s.renter as Record<string, string>)?.name ?? '—';
        const provider = (s.provider as Record<string, string>)?.name ?? '—';
        const line = String(s.id).padEnd(8) + String(s.schedule_id).padEnd(10) + started.padEnd(22) + dur.padEnd(10) + earned.padEnd(9) + s.status.padEnd(10) + renter.padEnd(16) + provider;
        process.stdout.write(line + '\n');
      }
    }
  } finally {
    await closeClient(client);
  }
}

async function cmdMyBrowsers(): Promise<void> {
  const apiKey = getApiKey();
  const client = await connect(apiKey, connectOptions());
  try {
    const results = await client.myBrowsers();
    out(results);
  } finally {
    await closeClient(client);
  }
}

async function cmdSnapshot(sid: string, args: string[]): Promise<void> {
  let outputPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) outputPath = args[++i];
  }
  if (!outputPath) {
    err('-o/--output is required', 'args');
    process.exit(1);
  }

  // Try daemon
  if (await isRunning()) {
    try {
      const result = await _daemonRequest('/snapshot', { session_id: sid }) as Record<string, unknown>;
      const pngBuf = Buffer.from(result.screenshot as string, 'base64');
      fs.writeFileSync(outputPath!, pngBuf);
      out({
        screenshot: outputPath,
        chat: result.chat,
        ts: result.ts,
      });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }

  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const lastSeen = getLastSeenTs(sid);
    browser._lastSeenTs = lastSeen;
    const snap = await browser.snapshot();
    const pngBuf = Buffer.from(snap.screenshot, 'base64');
    fs.writeFileSync(outputPath, pngBuf);
    if (browser._lastSeenTs) {
      updateLastSeenTs(sid, browser._lastSeenTs);
    }
    const chatList = snap.chat.map((m: ChatMessage) => ({
      from: m.sender_id,
      text: m.text,
      ts: m.created_at,
    }));
    out({ screenshot: outputPath, chat: chatList, ts: snap.ts.toISOString() });
  } finally {
    await closeClient(client);
  }
}

function parseNoHuman(args: string[]): boolean {
  return args.includes('--no-human') || args.includes('--raw');
}

async function cmdNavigate(sid: string, args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    err('URL is required', 'args');
    process.exit(1);
  }
  const raw = parseNoHuman(args);
  // Try daemon
  if (await isRunning()) {
    try {
      await _daemonRequest('/navigate', { session_id: sid, url, human: !raw });
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    await browser.navigate(url, 30000, raw ? { human: false } : undefined);
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdClick(sid: string, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const x = parseInt(positional[0], 10);
  const y = parseInt(positional[1], 10);
  if (isNaN(x) || isNaN(y)) {
    err('x and y coordinates are required', 'args');
    process.exit(1);
  }
  const raw = parseNoHuman(args);
  // Try daemon
  if (await isRunning()) {
    try {
      await _daemonRequest('/click', { session_id: sid, x, y, human: !raw });
      out({ ok: true, pointer: [x, y] });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    await browser.click(x, y, raw ? { human: false } : undefined);
    out({ ok: true, pointer: [x, y] });
  } finally {
    await closeClient(client);
  }
}

async function cmdType(sid: string, args: string[]): Promise<void> {
  // task 429/431 — typing is humanized BY DEFAULT in both modes. --no-human
  // (or --raw) flattens THIS call only. --natural is a no-op alias kept for
  // backwards compatibility.
  let text = '';
  let raw = false;
  let selector: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-human' || args[i] === '--raw') raw = true;
    else if (args[i] === '--natural') { /* no-op alias */ }
    else if (args[i] === '--selector' && args[i + 1]) selector = args[++i];
    else if (!text) text = args[i];
  }
  if (!text) {
    err('text is required', 'args');
    process.exit(1);
  }
  // Try daemon
  if (await isRunning()) {
    try {
      const typeOpts: Record<string, unknown> = { session_id: sid, text };
      if (selector) typeOpts.selector = selector;
      if (raw) typeOpts.human = false;
      await _daemonRequest('/type', typeOpts);
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const client = await connect(apiKey, connectOptions());
  try {
    const browser = await client.resume(sid);
    await browser.type(text, raw ? { human: false } : selector ? { selector } : undefined);
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdScroll(sid: string, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const x = parseInt(positional[0], 10);
  const y = parseInt(positional[1], 10);
  const dy = parseInt(positional[2], 10);
  if (isNaN(x) || isNaN(y) || isNaN(dy)) {
    err('x, y, dy are required', 'args');
    process.exit(1);
  }
  const raw = parseNoHuman(args);
  // Try daemon
  if (await isRunning()) {
    try {
      await _daemonRequest('/scroll', { session_id: sid, x, y, dy, human: !raw });
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const scrollOpts: Record<string, unknown> = { x, y, deltaY: dy };
    if (raw) scrollOpts.human = false;
    await browser.scroll(scrollOpts);
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdChat(sid: string, action: string, args: string[]): Promise<void> {
  // send-image is not available via daemon — keep one-shot only
  if (action === 'send-image') {
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      let imagePath: string | null = null;
      let text: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--image' && args[i + 1]) imagePath = args[++i];
        if (args[i] === '--text' && args[i + 1]) text = args[++i];
      }
      if (!imagePath) {
        err('--image is required', 'args');
        process.exit(1);
      }
      if (text) {
        await browser.chat.send(text);
      }
      const result = await browser.chat.sendImage(imagePath);
      out({ ok: true, message_id: result.messageId });
    } finally {
      await closeClient(client);
    }
    return;
  }

  // Actions that can be routed through daemon
  if (action === 'send') {
    const text = args[0];
    if (!text) {
      err('text is required', 'args');
      process.exit(1);
    }
    if (await isRunning()) {
      try {
        const result = await _daemonRequest('/chat/send', { session_id: sid, text }) as Record<string, unknown>;
        out({ ok: true, message_id: result.message_id });
        return;
      } catch (e) {
        err((e as Error).message, 'daemon');
        process.exit(6);
      }
    }
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      const result = await browser.chat.send(text);
      out({ ok: true, message_id: result.messageId });
    } finally {
      await closeClient(client);
    }
    return;
  }

  if (action === 'next') {
    let timeout = 60;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--timeout' && args[i + 1]) timeout = parseFloat(args[++i]);
    }
    if (await isRunning()) {
      try {
        const since = getLastSeenTs(sid) ?? undefined;
        const params: Record<string, unknown> = { session_id: sid, timeout };
        if (since) params.since = since;
        const result = await _daemonRequest('/chat/next', params);
        if (result !== null) {
          const r = result as Record<string, unknown>;
          out({ from: r.from, text: r.text, ts: r.ts });
        } else {
          out(null);
        }
        return;
      } catch (e) {
        err((e as Error).message, 'daemon');
        process.exit(6);
      }
    }
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      const lastSeen = getLastSeenTs(sid);
      const msgs = await browser.chat.history({ since: lastSeen ?? undefined });
      if (msgs.length > 0) {
        const m = msgs[0];
        updateLastSeenTs(sid, m.created_at);
        out({ from: m.sender_id, text: m.text, ts: m.created_at });
      } else {
        let resolved = false;
        const waitPromise = new Promise<ChatMessage | null>((resolve) => {
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve(null);
            }
          }, timeout * 1000);

          const handler = (msg: ChatMessage): void => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              browser.chat.offMessage(handler);
              resolve(msg);
            }
          };
          browser.chat.onMessage(handler);
        });

        const msg = await waitPromise;
        if (msg) {
          updateLastSeenTs(sid, msg.created_at);
          out({ from: msg.sender_id, text: msg.text, ts: msg.created_at });
        } else {
          out(null);
        }
      }
    } finally {
      await closeClient(client);
    }
    return;
  }

  if (action === 'history') {
    let since: string | undefined;
    let limit = 50;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--since' && args[i + 1]) {
        const val = args[++i];
        const asNum = Number(val);
        if (!isNaN(asNum) && val.match(/^\d+(\.\d+)?$/)) {
          since = new Date(asNum * 1000).toISOString();
        } else {
          since = val;
        }
      }
      if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    }
    if (await isRunning()) {
      try {
        const params: Record<string, unknown> = { session_id: sid, limit };
        if (since) params.since = since;
        out(await _daemonRequest('/chat/history', params));
        return;
      } catch (e) {
        err((e as Error).message, 'daemon');
        process.exit(6);
      }
    }
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      const msgs = await browser.chat.history({ since, limit });
      out(msgs.map((m: ChatMessage) => ({ from: m.sender_id, text: m.text, ts: m.created_at })));
    } finally {
      await closeClient(client);
    }
    return;
  }

  err(`Unknown chat action: ${action}`, 'args');
  process.exit(1);
}

async function cmdStop(sid: string): Promise<void> {
  // Try daemon
  if (await isRunning()) {
    try {
      await _daemonRequest('/stop', { session_id: sid });
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    await browser.close();
    deleteSession(sid);
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdProfile(sid: string, action: string, args: string[]): Promise<void> {
  if (action === 'export') {
    let outputPath: string | null = null;
    let domains: string[] | undefined;
    let noSessionStorage = false;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) outputPath = args[++i];
      if (args[i] === '--domains' && args[i + 1]) domains = args[++i].split(',').map(d => d.trim());
      if (args[i] === '--no-session-storage') noSessionStorage = true;
    }
    if (!outputPath) {
      err('-o/--output is required', 'args');
      process.exit(1);
    }
    // Try daemon
    if (await isRunning()) {
      try {
        const params: Record<string, unknown> = { session_id: sid, no_session_storage: noSessionStorage };
        if (domains) params.domains = domains.join(',');
        const profile = await _daemonRequest('/profile/export', params);
        fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2), 'utf-8');
        out({ ok: true, path: outputPath });
        return;
      } catch (e) {
        err((e as Error).message, 'daemon');
        process.exit(6);
      }
    }
    // Fallback to one-shot
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      const profile = await browser.profile.export({
        domains,
        includeSessionStorage: !noSessionStorage,
      });
      fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2), 'utf-8');
      out({ ok: true, path: outputPath });
    } finally {
      await closeClient(client);
    }
    return;
  }

  if (action === 'import') {
    let inputPath: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-i' || args[i] === '--input') && args[i + 1]) inputPath = args[++i];
    }
    if (!inputPath) {
      err('-i/--input is required', 'args');
      process.exit(1);
    }
    const profileData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    // Try daemon
    if (await isRunning()) {
      try {
        await _daemonRequest('/profile/import', { session_id: sid, profile: profileData });
        out({ ok: true });
        return;
      } catch (e) {
        err((e as Error).message, 'daemon');
        process.exit(6);
      }
    }
    // Fallback to one-shot
    const apiKey = getApiKey();
    const [client, browser] = await resumeBrowser(apiKey, sid);
    try {
      await browser.profile.import(profileData);
      out({ ok: true });
    } finally {
      await closeClient(client);
    }
    return;
  }

  err(`Unknown profile action: ${action}`, 'args');
  process.exit(1);
}

async function cmdWait(sid: string): Promise<void> {
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const reason = await browser.waitUntilEnded();
    out({ ended: true, reason });
  } finally {
    await closeClient(client);
  }
}

async function cmdScreenshot(sid: string, args: string[]): Promise<void> {
  let outputPath: string | null = null;
  let fullPage = false;
  let format: 'png' | 'jpeg' = 'png';
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) outputPath = args[++i];
    if (args[i] === '--full') fullPage = true;
    if (args[i] === '--format' && args[i + 1]) {
      const v = args[++i];
      if (v !== 'png' && v !== 'jpeg') {
        err('--format must be png or jpeg', 'args');
        process.exit(1);
      }
      format = v;
    }
  }
  if (!outputPath) {
    err('-o/--output is required', 'args');
    process.exit(1);
  }

  // Try daemon
  if (await isRunning()) {
    try {
      const result = await _daemonRequest('/screenshot', { session_id: sid, full: fullPage, format }) as Record<string, unknown>;
      const imgBuf = Buffer.from(result.data as string, 'base64');
      fs.writeFileSync(outputPath!, imgBuf);
      out({ ok: true, path: outputPath });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }

  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    let data: Buffer;
    if (format === 'jpeg') {
      // JPEG via _cdpFormat — SDK returns {data: base64}, CLI decodes
      const result = await browser.screenshot({ format: 'base64', fullPage, _cdpFormat: 'jpeg' });
      data = Buffer.from((result as { data: string }).data, 'base64');
    } else {
      // PNG default — SDK returns raw Buffer
      data = await browser.screenshot({ format: 'png', fullPage }) as Buffer;
    }
    fs.writeFileSync(outputPath, data);
    out({ ok: true, path: outputPath });
  } finally {
    await closeClient(client);
  }
}

async function cmdSwitchTab(sid: string): Promise<void> {
  if (await isRunning()) {
    try {
      await _daemonRequest('/switch-tab', { session_id: sid });
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    await browser.switchTab();
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdConfigure(sid: string, args: string[]): Promise<void> {
  const opts: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--masking-mode' && args[i + 1]) opts.maskingMode = parseBool(args[++i]);
    if (args[i] === '--fingerprint' && args[i + 1]) opts.fingerprint = parseBool(args[++i]);
  }
  if (await isRunning()) {
    try {
      await _daemonRequest('/configure', { session_id: sid, masking_mode: opts.maskingMode, fingerprint: opts.fingerprint });
      out({ ok: true });
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    await browser.configure(opts as { maskingMode?: boolean; fingerprint?: boolean });
    out({ ok: true });
  } finally {
    await closeClient(client);
  }
}

async function cmdCdp(sid: string, args: string[]): Promise<void> {
  let method: string | null = null;
  let params: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--method' && args[i + 1]) method = args[++i];
    if (args[i] === '--params' && args[i + 1]) params = JSON.parse(args[++i]);
  }
  if (!method) {
    err('--method is required', 'args');
    process.exit(1);
  }
  if (await isRunning()) {
    try {
      out(await _daemonRequest('/cdp', { session_id: sid, method, params }));
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const result = await browser.send({ method, params });
    out(result);
  } finally {
    await closeClient(client);
  }
}

async function cmdRequestCaptcha(sid: string, args: string[]): Promise<void> {
  let acceptance = 60;
  let completion = 120;
  let manual = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--acceptance' && args[i + 1]) acceptance = parseFloat(args[++i]);
    if (args[i] === '--completion' && args[i + 1]) completion = parseFloat(args[++i]);
    if (args[i] === '--manual') manual = true;
  }
  if (await isRunning()) {
    try {
      const result = await _daemonRequest('/request-captcha', {
        session_id: sid, acceptance, completion, manual,
      }) as Record<string, unknown>;
      out(result);
      if (result.solved === false) process.exit(1);
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const result = await browser.requestCaptcha({
      acceptanceTimeout: acceptance,
      completionTimeout: completion,
      autoAccept: !manual,
    });
    out({
      solved: result.solved,
      proof_message_id: result.proofMessageId,
      cancel_reason: result.cancelReason,
      child_event_id: result.childEventId,
      correction_id: result.correctionId,
    });
    if (!result.solved) process.exit(1);
  } catch (e) {
    if (e instanceof CaptchaTimeoutError) {
      out({ solved: false, cancel_reason: `timeout:${e.phase}`, child_event_id: null, correction_id: null });
      process.exit(1);
    }
    throw e;
  } finally {
    await closeClient(client);
  }
}

async function cmdUpload(sid: string, args: string[]): Promise<void> {
  let selector: string | null = null;
  let filePath: string | null = null;
  let filename: string | undefined;
  let mime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--selector' && args[i + 1]) selector = args[++i];
    if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
    if (args[i] === '--filename' && args[i + 1]) filename = args[++i];
    if (args[i] === '--mime' && args[i + 1]) mime = args[++i];
  }
  if (!selector || !filePath) {
    err('--selector and --file are required', 'args');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    err(`File not found: ${filePath}`, 'args');
    process.exit(1);
  }
  // Try daemon
  if (await isRunning()) {
    try {
      const result = await _daemonRequest('/upload', { session_id: sid, selector, file_path: filePath, filename, mime_type: mime });
      out(result);
      return;
    } catch (e) {
      err((e as Error).message, 'daemon');
      process.exit(6);
    }
  }
  // Fallback to one-shot
  const apiKey = getApiKey();
  const [client, browser] = await resumeBrowser(apiKey, sid);
  try {
    const result = await browser.upload(selector, filePath, filename, mime);
    out(result);
  } finally {
    await closeClient(client);
  }
}

// ── Daemon commands ───────────────────────────────────────────────────────

async function cmdDaemon(args: string[]): Promise<void> {
  const action = args[0];
  if (!action) {
    err('Usage: ceki daemon start|stop|status', 'args');
    process.exit(1);
  }

  switch (action) {
    case 'start': {
      const health = await checkHealth();
      if (health?.ok === true) {
        err('daemon is already running', 'daemon');
        process.exit(1);
      }
      const server = new DaemonServer();
      // Graceful shutdown on SIGTERM/SIGINT
      const shutdown = async (): Promise<void> => {
        try { await server.stop(); } catch { /* ignore */ }
        process.exit(0);
      };
      process.on('SIGTERM', () => { void shutdown(); });
      process.on('SIGINT', () => { void shutdown(); });
      await server.start();
      // Block — keep alive until signal
      await new Promise(() => { /* never resolves */ });
      break;
    }
    case 'stop': {
      const port = Number.parseInt(process.env.CEKI_DAEMON_PORT ?? '18777', 10);
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`);
        if (!resp.ok) {
          err('daemon is not running', 'daemon');
          process.exit(1);
        }
      } catch {
        err('daemon is not running', 'daemon');
        process.exit(1);
      }
      // Send SIGTERM to the daemon process
      const pidFile = '/tmp/ceki-daemon.pid';
      if (fs.existsSync(pidFile)) {
        const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid && !Number.isNaN(pid)) {
          process.kill(pid, 'SIGTERM');
          // Wait briefly for shutdown
          await new Promise((r) => setTimeout(r, 500));
          out({ ok: true });
          return;
        }
      }
      err('PID file not found, daemon may not be running', 'daemon');
      process.exit(1);
      break;
    }
    case 'status': {
      const health = await checkHealth();
      if (health?.ok === true) {
        out({ running: true, pid: health.pid });
      } else {
        out({ running: false });
      }
      break;
    }
    default:
      err(`Unknown daemon action: ${action}`, 'args');
      process.exit(1);
  }
}

// --- Help ---

function printHelp(): void {
  console.log(`ceki — CLI for browser.ceki.me rental

Usage: ceki <command> [options]

Commands:
  rent --schedule N [--fingerprint-from PATH]
  my-browsers
  search [--limit N] [--filter k=v]...
  snapshot <sid> -o PATH
  screenshot <sid> -o PATH [--full] [--format png|jpeg]
  navigate <sid> <url> [--no-human|--raw]
  click <sid> <x> <y> [--no-human|--raw]
  type <sid> "<text>" [--no-human|--raw]   (humanized by default)
  scroll <sid> <x> <y> <dy> [--no-human|--raw]
  switch-tab <sid>
  configure <sid> [--masking-mode true|false] [--fingerprint true|false]
  cdp <sid> --method <M> [--params JSON]
  upload <sid> --selector CSS --file PATH [--filename NAME] [--mime TYPE]
  request-captcha <sid> [--acceptance N] [--completion M] [--manual]
  wait <sid>
  chat <sid> send "<text>"
  chat <sid> send-image --image PATH [--text "..."]
  chat <sid> next [--timeout N]
  chat <sid> history [--since TS] [--limit N]
  profile export <sid> -o file [--domains a,b,c] [--no-session-storage]
  profile import <sid> -i file
  stop <sid>

  daemon start           Start persistent daemon (HTTP IPC on 127.0.0.1:18777)
  daemon stop            Stop daemon gracefully
  daemon status          Check if daemon is running

  contract list
  contract members <cid>
  contract tasks [cid]                (default: CEKI_CONTRACT_IDS)
  contract my-events                  (get-my-events — contract events assigned to me; the plate feed)
  contract call-human <eid> --kind input|review|stuck --desc "..."
  contract task <eid>
  contract children <eid>
  contract history <eid> [--limit N]
  contract create [cid] --label X [--type N] [--status N] [--kal-schedule N]
                       [--start S] [--end E] [--timezone TZ] [--date D]
                       [--duration N] [--amount N] [--currency C]
                       [--benefitable agent:N|user:N]
                       [--reviewer agent:N|user:N|creator|owner] [--qa agent:N|user:N]
                       [--participant agent:N:reviewer|user:N:qa|agent:N:role:NUM]...
                       [--desc text] [--data JSON]
                       [--tags key[:label[:color]],...]
  contract comment <eid> [--label X] [--type N] [--status N] [--start S]
                          [--end E] [--date D] [--duration N] [--amount N]
                          [--currency C] [--benefitable agent:N] [--desc text]
  contract propose <eid> [--status N] [--label X] [--desc text] [--start S]
                          [--end E] [--date D] [--duration N] [--amount N]
                          [--currency C] [--benefitable agent:N|user:N]
                          [--reviewer agent:N|user:N|creator|owner]
                          [--qa agent:N|user:N]
                          [--participant type:id:role]...
  contract edit <eid> [--status N] [--label X] [--desc text] [--start S]
                       [--end E] [--date D] [--duration N] [--amount N]
                       [--currency C] [--benefitable agent:N|user:N]
                       [--tags key[:label[:color]],...]
  contract progress <eid> [--status N] --desc TEXT
  contract vote <eid> --ids 1,2,3 --vote true|false
  contract poll
  contract watch [interval]
  contract tools
  contract raw <tool> [JSON]

  timelog start <event_id>
  timelog stop <event_id> [--label TEXT]
  timelog check <event_id>

  hire my-jobs                        (get-my-jobs — hire schedules I posted, type 3)

Environment:
  CEKI_API_KEY (required)
  CEKI_RELAY_URL (default: wss://browser.ceki.me/ws/agent)
  CEKI_API_URL (default: https://api.ceki.me)
  CEKI_CHAT_URL (default: https://chat.ceki.me/api/chat)
  CEKI_BASIC_AUTH_USER / CEKI_BASIC_AUTH_PASS (optional)
  CEKI_AGENT_TOKEN (contract/timelog; falls back to CEKI_API_KEY)
  CEKI_AGENT_MCP_ENDPOINT (override /mcp/agent endpoint)
  CEKI_CONTRACT_IDS (default contract for 'contract tasks'/'create')

Exit codes: 0=success, 1=error, 2=auth, 3=session_not_found, 4=timeout, 5=network`);
}

// --- Main ---

async function main(): Promise<void> {
  loadConfig(); // ~/.ceki/config → process.env (env wins, silent if missing)

  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    const pkgPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      console.log(pkg.version);
    } catch {
      console.log('unknown');
    }
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === 'contract') {
    process.exit(await cmdContract(rest));
  }
  if (command === 'hire') {
    process.exit(await cmdHire(rest));
  }
  if (command === 'timelog') {
    process.exit(await cmdTimelog(rest));
  }
  if (command === 'daemon') {
    process.exit(await cmdDaemon(rest));
  }

  switch (command) {
    case 'rent':
      await cmdRent(rest);
      break;
    case 'search':
      await cmdSearch(rest);
      break;
    case 'sessions':
      await cmdSessions(rest);
      break;
    case 'my-browsers':
      await cmdMyBrowsers();
      break;
    case 'snapshot':
      await cmdSnapshot(rest[0], rest.slice(1));
      break;
    case 'navigate':
      await cmdNavigate(rest[0], rest.slice(1));
      break;
    case 'click':
      await cmdClick(rest[0], rest.slice(1));
      break;
    case 'type':
      await cmdType(rest[0], rest.slice(1));
      break;
    case 'scroll':
      await cmdScroll(rest[0], rest.slice(1));
      break;
    case 'switch-tab':
      await cmdSwitchTab(rest[0]);
      break;
    case 'configure':
      await cmdConfigure(rest[0], rest.slice(1));
      break;
    case 'cdp':
      await cmdCdp(rest[0], rest.slice(1));
      break;
    case 'upload':
      await cmdUpload(rest[0], rest.slice(1));
      break;
    case 'request-captcha':
      await cmdRequestCaptcha(rest[0], rest.slice(1));
      break;
    case 'wait':
      await cmdWait(rest[0]);
      break;
    case 'stop':
      await cmdStop(rest[0]);
      break;
    case 'screenshot':
      await cmdScreenshot(rest[0], rest.slice(1));
      break;
    case 'chat':
      if (rest.length < 2) {
        err('Usage: ceki chat <sid> <action> [args]', 'args');
        process.exit(1);
      }
      await cmdChat(rest[0], rest[1], rest.slice(2));
      break;
    case 'profile':
      if (rest.length < 2) {
        err('Usage: ceki profile export|import <sid> [args]', 'args');
        process.exit(1);
      }
      await cmdProfile(rest[1], rest[0], rest.slice(2));
      break;
    default:
      err(`Unknown command: ${command}`, 'args');
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  if (e instanceof SessionExpired || e instanceof SessionNotFound) {
    err(String(e), 'session_not_found');
    process.exit(3);
  }
  if (e instanceof NotOwner) {
    err(String(e), 'not_owner');
    process.exit(3);
  }
  if (e instanceof TimeoutError) {
    err(String(e), 'timeout');
    process.exit(4);
  }
  if (e instanceof ConnectionLost || e instanceof AuthError || e instanceof TransportError) {
    err(String(e), 'network');
    process.exit(5);
  }
  if (e instanceof CekiBrowserError) {
    err(String(e), 'ceki_error');
    process.exit(1);
  }
  err(e instanceof Error ? e.message : String(e), 'error');
  process.exit(1);
});
