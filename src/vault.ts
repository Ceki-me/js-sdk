import type { Browser } from './browser.js';
import type { Client } from './client.js';
import type { Profile, VaultEnvelope, VaultProfile } from './types.js';

/**
 * Fields CDP/the extension accept on Network.setCookies. The raw jar comes
 * back with extra diagnostic keys (priority, size, session, sourcePort,
 * sourceScheme) that the browser rejects on set — keep only the settable ones.
 * Mirrors python-sdk `ceki_sdk._vault.SERIALIZABLE_COOKIE_FIELDS`.
 */
export const SERIALIZABLE_COOKIE_FIELDS = [
  'name', 'value', 'domain', 'path', 'secure', 'httpOnly',
  'expires', 'sameSite', 'session',
] as const;

export type SettableCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  sameSite?: 'Strict' | 'Lax' | 'None' | undefined;
  session?: boolean;
};

/**
 * Strip non-settable CDP fields from cookie objects.
 *
 * Network.getCookies returns extra fields (size, sourcePort, ...) that
 * Network.setCookies rejects; the extension's VaultProfile contract only
 * carries the settable subset. Returns a shallow copy per cookie, dropping
 * entries without a name/value/domain.
 */
export function sanitizeCookies(cookies: unknown): SettableCookie[] {
  const out: SettableCookie[] = [];
  if (!Array.isArray(cookies)) return out;
  for (const raw of cookies) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== 'string' || !c.name) continue;
    if (typeof c.value !== 'string') continue;
    const outCookie: SettableCookie = { name: c.name, value: c.value, domain: String(c.domain ?? '') };
    for (const key of SERIALIZABLE_COOKIE_FIELDS) {
      if (key === 'name' || key === 'value' || key === 'domain') continue;
      const v = c[key];
      if (v !== undefined) (outCookie as Record<string, unknown>)[key] = v;
    }
    out.push(outCookie);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRecordRecord(v: unknown): v is Record<string, Record<string, string>> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((val) => isRecord(val));
}

/**
 * Convert a `profile.export()` blob into the vault session `data` envelope.
 *
 * `profile.export()` returns a flat single-origin snapshot::
 *
 *   {schema_version, fingerprint, origin, cookies,
 *    localStorage: {k: v}, sessionStorage: {k: v}}
 *
 * The vault API (and the extension's `session.configure` profile) expects a
 * per-origin envelope::
 *
 *   {fingerprint, cookies,
 *    localStorage: {<origin>: {...}}, sessionStorage: {<origin>: {...}},
 *    urls: [...], collectedAt: ISO}
 *
 * localStorage/sessionStorage are best-effort CDP captures of the currently
 * loaded origin, so the snapshot's `origin` is the natural key. If the
 * incoming storage is already per-origin (values are dicts — e.g. a vault
 * envelope being re-uploaded), it is passed through untouched. Mirrors
 * python-sdk `ceki_sdk._vault.normalize_profile_for_vault`.
 */
export function normalizeProfileForVault(profile: Profile | VaultEnvelope): VaultEnvelope {
  const p = profile as Record<string, unknown>;
  const envelope: VaultEnvelope = {
    fingerprint: isRecord(p.fingerprint) ? p.fingerprint : undefined,
    cookies: sanitizeCookies(p.cookies),
  };

  const origin = typeof p.origin === 'string' && p.origin ? p.origin : 'https://localhost';

  function wrap(storage: unknown): Record<string, Record<string, string>> | undefined {
    if (!isRecord(storage)) return undefined;
    if (isRecordRecord(storage)) return storage as Record<string, Record<string, string>>;
    return { [origin]: storage as Record<string, string> };
  }

  envelope.localStorage = wrap(p.localStorage);
  envelope.sessionStorage = wrap(p.sessionStorage);

  const urlsRaw = p.urls;
  if (Array.isArray(urlsRaw)) {
    envelope.urls = urlsRaw.filter((u): u is string => typeof u === 'string');
  } else if (origin && origin !== 'https://localhost') {
    envelope.urls = [origin];
  } else {
    envelope.urls = [];
  }

  const collectedAt = typeof p.collectedAt === 'string' && p.collectedAt
    ? p.collectedAt
    : new Date().toISOString();
  envelope.collectedAt = collectedAt;

  return envelope;
}

/**
 * Normalize a fetched vault session `data` for `session.configure`.
 *
 * Passes through per-origin localStorage/sessionStorage (the extension buffers
 * them by origin) and sanitizes cookies. `fingerprint` is intentionally NOT
 * copied into the profile — it is applied via the top-level `fingerprint`
 * configure field so the extension's existing fingerprint path stays the single
 * source of truth. Unknown keys are dropped. Mirrors
 * `ceki_sdk._vault.minimal_vault_profile`.
 */
export function minimalVaultProfile(data: VaultEnvelope): VaultProfile {
  const profile: VaultProfile = {};
  const cookies = sanitizeCookies(data.cookies);
  if (cookies.length > 0) profile.cookies = cookies;
  if (isRecord(data.localStorage)) profile.localStorage = data.localStorage as Record<string, Record<string, string>>;
  if (isRecord(data.sessionStorage)) profile.sessionStorage = data.sessionStorage as Record<string, Record<string, string>>;
  return profile;
}

/**
 * Minimal view of a vault session as returned by the API. Mirrors
 * `ceki_sdk._vault.VaultSession`.
 */
export class VaultSession {
  readonly id: number;
  readonly label: string | null;
  readonly userId: number | null;
  readonly data: VaultEnvelope;
  readonly urls: string[];
  readonly lastBrowser: string | null;
  readonly privacy: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;

  constructor(payload: Record<string, unknown>) {
    const rawData = payload.data;
    // The backend may return the encrypted blob as-is (index serializes a
    // string) or as a truncated list row (urls top-level) — only treat it as
    // the decrypted profile when it's a dict with the envelope shape.
    const isEnvelope = isRecord(rawData) && (
      'cookies' in rawData || 'localStorage' in rawData || 'urls' in rawData || 'fingerprint' in rawData
    );
    this.data = isEnvelope ? (rawData as unknown as VaultEnvelope) : {};

    let urls: unknown = payload.urls;
    if (!Array.isArray(urls) && Array.isArray(this.data.urls)) urls = this.data.urls;
    this.urls = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string') : [];

    const rawId = payload.id;
    this.id = rawId != null ? Number(rawId) : 0;
    this.label = typeof payload.label === 'string' ? payload.label : null;
    this.userId = payload.user_id != null ? Number(payload.user_id) : null;
    this.lastBrowser = typeof payload.last_browser === 'string' ? payload.last_browser : null;
    this.privacy = payload.privacy != null ? Number(payload.privacy) : 1;
    this.createdAt = typeof payload.created_at === 'string' ? payload.created_at : null;
    this.updatedAt = typeof payload.updated_at === 'string' ? payload.updated_at : null;
  }
}

/** JSON body returned by create: { id } */
interface CreateBody {
  id?: unknown;
}

/** HTTP error with status for vault API calls. */
export class VaultHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'VaultHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * HTTP client for `/api/vault/sessions` (Vault 1-5 backend).
 *
 * Lives on `client.vault`. All methods are plain `fetch` calls — no relay /
 * websocket involvement — so they work before a session is rented.
 *
 * The vault routes are guarded by Sanctum (`auth:sanctum_or_agent`) and on
 * older backends resolve the token to a *user*; agent `ag_` keys are accepted
 * by the dev backend only when the `sanctum_or_agent` middleware is wired in.
 * For now, use a user Sanctum token as `apiKey` for vault operations when the
 * agent-key path returns 401. Mirrors `ceki_sdk._vault.ClientVault`.
 */
export class ClientVault {
  /** @internal */
  _client: Client;

  constructor(client: Client) {
    this._client = client;
  }

  /** @internal */
  _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this._client._apiKey}`,
      'Content-Type': 'application/json',
    };
    const basicAuth = this._client._basicAuth;
    if (basicAuth) {
      const encoded = Buffer.from(`${basicAuth[0]}:${basicAuth[1]}`).toString('base64');
      headers['X-Basic-Auth'] = `Basic ${encoded}`;
    }
    return headers;
  }

  private async _request(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${this._client._apiUrl}${path}`;
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers: this._headers() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new VaultHttpError(0, `vault request failed: ${msg}`);
    }
    if (!resp.ok) {
      let body: unknown;
      try {
        body = await resp.json();
      } catch {
        body = await resp.text().catch(() => '');
      }
      const detail = isRecord(body) && typeof body.message === 'string'
        ? body.message
        : isRecord(body) && typeof body.error === 'string'
          ? body.error
          : `HTTP ${resp.status}`;
      throw new VaultHttpError(resp.status, `vault API ${init?.method ?? 'GET'} ${path} -> ${detail}`, body);
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** List vault sessions (paginated by the backend, default 20/page). */
  async list(params?: Record<string, string | number | boolean>): Promise<VaultSession[]> {
    const qs = new URLSearchParams();
    const p: Record<string, string | number | boolean> = params ?? { per_page: 20 };
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const body = await this._request(`/api/vault/sessions?${qs.toString()}`);
    if (isRecord(body)) {
      const data = body.data;
      if (Array.isArray(data)) {
        return data.filter(isRecord).map((x) => new VaultSession(x));
      }
    }
    if (Array.isArray(body)) return body.filter(isRecord).map((x) => new VaultSession(x));
    return [];
  }

  /** Fetch a vault session with its DECRYPTED `data` profile (show). */
  async get(vaultSessionId: number): Promise<VaultSession> {
    const body = await this._request(`/api/vault/sessions/${vaultSessionId}`);
    if (!isRecord(body)) throw new VaultHttpError(404, `vault session ${vaultSessionId} not found`);
    return new VaultSession(body);
  }

  /** Create a vault session; returns the new session id. */
  async create(data: VaultEnvelope, opts?: { label?: string | null; privacy?: number }): Promise<number> {
    const payload: Record<string, unknown> = { data };
    if (opts?.label != null) payload.label = opts.label;
    if (opts?.privacy != null) payload.privacy = opts.privacy;
    const body = await this._request('/api/vault/sessions', { method: 'POST', body: JSON.stringify(payload) }) as CreateBody | null;
    const rawId = body?.id;
    if (rawId == null) throw new VaultHttpError(201, 'vault create returned no id');
    return Number(rawId);
  }

  /** Overwrite an existing vault session's data (PUT, server encrypts). */
  async update(
    vaultSessionId: number,
    data: VaultEnvelope,
    opts?: { label?: string | null; privacy?: number },
  ): Promise<VaultSession> {
    const payload: Record<string, unknown> = { data };
    if (opts?.label != null) payload.label = opts.label;
    if (opts?.privacy != null) payload.privacy = opts.privacy;
    const body = await this._request(`/api/vault/sessions/${vaultSessionId}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (!isRecord(body)) throw new VaultHttpError(500, 'vault update returned unexpected payload');
    return new VaultSession(body);
  }

  /** Delete a vault session (owner only, i.e. a user token). */
  async delete(vaultSessionId: number): Promise<void> {
    await this._request(`/api/vault/sessions/${vaultSessionId}`, { method: 'DELETE' });
  }
}

/**
 * Vault sugar on a live {@link Browser} (snapshot save / profile restore).
 *
 * Available as `browser.vault`. Saving snapshots the current browser state
 * through `browser.profile.export()` and pushes it to the vault. Restoring
 * pulls a vault session and replays it into the current browser via
 * `session.configure(profile=...)` (cookies immediately, storage buffered by
 * the extension until first navigation to each origin) plus a fingerprint
 * configure when the profile carries one. Mirrors
 * `ceki_sdk._vault.BrowserVault`.
 */
export class BrowserVault {
  private _browser: Browser;
  private _clientVault: ClientVault;

  constructor(browser: Browser) {
    this._browser = browser;
    this._clientVault = browser._client.vault;
  }

  /**
   * Snapshot the current browser into a vault session on the API.
   *
   * Returns the vault session id. When the browser was rented with
   * `vault=<id>` (a bound session), the snapshot overwrites that session
   * (PUT). Otherwise a new session is created (POST). `overwrite=true` forces
   * a PUT against the bound id (no-op if no bound id).
   */
  async save(opts?: {
    label?: string | null;
    includeSessionStorage?: boolean;
    domains?: string[];
    overwrite?: boolean;
    privacy?: number;
  }): Promise<number> {
    const profile = await this._browser.profile.export({
      includeSessionStorage: opts?.includeSessionStorage,
      domains: opts?.domains,
    });
    const envelope = normalizeProfileForVault(profile);
    const bound = this._browser._vaultSessionId;
    if (opts?.overwrite || (bound != null && !opts?.label)) {
      if (bound == null) {
        throw new Error('no bound vault session to overwrite; rent with vault=<id>');
      }
      await this._clientVault.update(bound, envelope, { label: opts?.label ?? null, privacy: opts?.privacy });
      return bound;
    }
    return this._clientVault.create(envelope, { label: opts?.label ?? null, privacy: opts?.privacy });
  }

  /** Fetch a vault session's decrypted profile envelope (`data`). */
  async load(vaultSessionId: number): Promise<VaultEnvelope> {
    const session = await this._clientVault.get(vaultSessionId);
    const data = session.data;
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      throw new Error(`vault session ${vaultSessionId} has no profile data`);
    }
    return data;
  }

  /**
   * Replay a vault profile into the current browser.
   *
   * `vaultSessionId` may be a number (fetched from the API) or a raw profile
   * envelope dict. Cookies are applied immediately (domain-scoped);
   * localStorage/sessionStorage are buffered by the extension and flushed on
   * first navigation to each origin; fingerprint (if present in the profile)
   * is applied through the top-level `session.configure` fingerprint field.
   */
  async restore(vaultSessionId: number | Record<string, unknown>): Promise<void> {
    let data: VaultEnvelope;
    if (typeof vaultSessionId === 'object' && vaultSessionId !== null) {
      data = vaultSessionId as unknown as VaultEnvelope;
    } else {
      data = await this.load(Number(vaultSessionId));
      this._browser._vaultSessionId = Number(vaultSessionId);
    }

    const profile = minimalVaultProfile(data);
    const fingerprint = data.fingerprint;
    const hasFingerprint = isRecord(fingerprint) && Object.keys(fingerprint).length > 0;

    const configureOpts: { profile: VaultProfile; fingerprint?: Record<string, unknown> } = { profile };
    if (hasFingerprint) configureOpts.fingerprint = fingerprint;
    await this._browser.configure(configureOpts);
  }
}