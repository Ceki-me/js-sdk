import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.ceki', 'sessions');

function statePath(sid: string): string {
  return path.join(STATE_DIR, `${sid}.json`);
}

export function loadSession(sid: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(statePath(sid), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveSession(sid: string, data: Record<string, unknown>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload = { ...data, updated_at: new Date().toISOString() };
  fs.writeFileSync(statePath(sid), JSON.stringify(payload, null, 2), 'utf-8');
}

export function deleteSession(sid: string): void {
  try {
    fs.unlinkSync(statePath(sid));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function getLastSeenTs(sid: string): string | null {
  const data = loadSession(sid);
  if (!data) return null;
  return (data.last_seen_ts as string) ?? null;
}

export function updateLastSeenTs(sid: string, ts: string): void {
  const data = loadSession(sid) ?? {};
  data.last_seen_ts = ts;
  saveSession(sid, data);
}
