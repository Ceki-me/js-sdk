// Session state persistence — Node-only (writes .ceki/sessions JSON files).
// In the browser bundle the node imports below are never loaded at module
// scope; every function that touches disk is a no-op there, so the rest of
// the SDK (rent / CDP / P2P) works unchanged in the browser.

type NodeFs = {
  readFileSync(p: string, e: string): string;
  mkdirSync(p: string, o: { recursive: boolean }): void;
  writeFileSync(p: string, c: string, e: string): void;
  unlinkSync(p: string): void;
};
type NodePath = { join(...parts: string[]): string };
type NodeOs = { homedir(): string };

function nodeRequire(): { fs: NodeFs; path: NodePath; os: NodeOs } {
  const req = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof req === 'undefined') throw new Error('node:fs unavailable');
  return {
    fs: req('node:fs') as NodeFs,
    path: req('node:path') as NodePath,
    os: req('node:os') as NodeOs,
  };
}

function isNode(): boolean {
  return typeof (globalThis as { require?: unknown }).require === 'function';
}

function statePath(node: { fs: NodeFs; path: NodePath; os: NodeOs }, sid: string): string {
  return node.path.join(node.os.homedir(), '.ceki', 'sessions', `${sid}.json`);
}

function mkStateDir(node: { fs: NodeFs; path: NodePath; os: NodeOs }): void {
  const dir = node.path.join(node.os.homedir(), '.ceki', 'sessions');
  node.fs.mkdirSync(dir, { recursive: true });
}

export function loadSession(sid: string): Record<string, unknown> | null {
  if (!isNode()) return null;
  try {
    const node = nodeRequire();
    const raw = node.fs.readFileSync(statePath(node, sid), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveSession(sid: string, data: Record<string, unknown>): void {
  if (!isNode()) return;
  try {
    const node = nodeRequire();
    mkStateDir(node);
    const payload = { ...data, updated_at: new Date().toISOString() };
    node.fs.writeFileSync(statePath(node, sid), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Non-fatal — persistence is best-effort (browser no-op).
  }
}

export function deleteSession(sid: string): void {
  if (!isNode()) return;
  try {
    const node = nodeRequire();
    node.fs.unlinkSync(statePath(node, sid));
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