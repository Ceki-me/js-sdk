import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  sanitizeCookies,
  normalizeProfileForVault,
  minimalVaultProfile,
  VaultSession,
  ClientVault,
  BrowserVault,
  VaultHttpError,
} from '../src/vault.js';
import type { VaultEnvelope, VaultProfile } from '../src/types.js';

// A decrypted vault session envelope exactly as /api/vault/sessions/{id} returns it.
const SAMPLE_VAULT_DATA: VaultEnvelope = {
  fingerprint: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0',
    canvasNoise: 0.00041478621121495963,
  },
  cookies: [
    {
      name: 'auth-refresh-remember',
      value: 'ed2679ccfa8e6b3ab8dc3ec0215363ab',
      domain: '.vc.ru',
      path: '/',
      secure: true,
      httpOnly: true,
      expires: 1796120019.910119,
      sameSite: 'Lax',
      session: false,
    },
  ],
  localStorage: {
    'https://vc.ru': {
      user: '{"id":5537554,"name":"Kom"}',
      'auth-refresh-token': '{"token":"ed2679cc","expTimestamp":1796120019}',
    },
  },
  sessionStorage: {
    'https://vc.ru': { '__ym_tab_guid': '62152f98' },
  },
  urls: ['https://vc.ru/education_on_vc_ru/3163579'],
  collectedAt: '2026-10-02T10:13:43.756Z',
};

// ── sanitizeCookies ────────────────────────────────────────────────────────

describe('sanitizeCookies', () => {
  it('strips CDP-only diagnostic fields', () => {
    const raw = [
      {
        name: 'a',
        value: '1',
        domain: '.vc.ru',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: 1796120019.91,
        sameSite: 'Lax',
        priority: 'Medium',
        size: 85,
        sourcePort: 443,
        sourceScheme: 'Secure',
        session: false,
      },
    ];
    const out = sanitizeCookies(raw);
    expect(out).toEqual([
      {
        name: 'a',
        value: '1',
        domain: '.vc.ru',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: 1796120019.91,
        sameSite: 'Lax',
        session: false,
      },
    ]);
  });

  it('skips invalid entries (missing name/value, non-dict)', () => {
    const raw = [
      { name: 'ok', value: '1', domain: '.x.com' },
      { name: 'no-value', domain: '.x.com' },
      { name: 'int-value', value: 2, domain: '.x.com' },
      'not-a-dict',
    ];
    expect(sanitizeCookies(raw)).toEqual([{ name: 'ok', value: '1', domain: '.x.com' }]);
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeCookies(undefined)).toEqual([]);
    expect(sanitizeCookies(null)).toEqual([]);
    expect(sanitizeCookies({})).toEqual([]);
  });
});

// ── profile envelope conversion ────────────────────────────────────────────

describe('normalizeProfileForVault', () => {
  it('wraps a flat profile.export() blob into a per-origin envelope', () => {
    const flat = {
      schema_version: 2,
      fingerprint: { userAgent: 'ua', canvasNoise: 0.1 },
      origin: 'https://vc.ru',
      cookies: [
        { name: 'a', value: '1', domain: '.vc.ru', path: '/', size: 85, sourcePort: 443 },
      ],
      localStorage: { user: '{"id":1}' },
      sessionStorage: { tab: 'guid' },
    };
    const out = normalizeProfileForVault(flat as never);
    expect(out.cookies).toEqual([{ name: 'a', value: '1', domain: '.vc.ru', path: '/' }]);
    expect(out.localStorage).toEqual({ 'https://vc.ru': { user: '{"id":1}' } });
    expect(out.sessionStorage).toEqual({ 'https://vc.ru': { tab: 'guid' } });
    expect(out.urls).toEqual(['https://vc.ru']);
    expect(typeof out.collectedAt).toBe('string');
    expect(out.fingerprint).toEqual({ userAgent: 'ua', canvasNoise: 0.1 });
  });

  it('passes through already-per-origin storage untouched', () => {
    const envelope = {
      cookies: [{ name: 'a', value: '1', domain: '.vc.ru', path: '/' }],
      localStorage: { 'https://vc.ru': { user: '{"id":1}' } },
      sessionStorage: { 'https://vc.ru': { tab: 'guid' } },
      urls: ['https://vc.ru/a'],
    };
    const out = normalizeProfileForVault(envelope as never);
    expect(out.localStorage).toEqual(envelope.localStorage);
    expect(out.sessionStorage).toEqual(envelope.sessionStorage);
    expect(out.urls).toEqual(['https://vc.ru/a']);
  });

  it('falls back to https://localhost origin key when origin missing', () => {
    const flat = {
      schema_version: 2,
      cookies: [{ name: 'a', value: '1', domain: 'localhost', path: '/' }],
      localStorage: { user: '{"id":1}' },
    };
    const out = normalizeProfileForVault(flat as never);
    expect(out.localStorage).toEqual({ 'https://localhost': { user: '{"id":1}' } });
    expect(out.urls).toEqual([]);
  });
});

// ── minimalVaultProfile ────────────────────────────────────────────────────

describe('minimalVaultProfile', () => {
  it('builds a session.configure profile from an envelope', () => {
    const out = minimalVaultProfile(SAMPLE_VAULT_DATA);
    // fingerprint stays OUT of the profile (applied via top-level configure)
    expect(out).not.toHaveProperty('fingerprint');
    expect(out.cookies).toEqual([
      { name: 'auth-refresh-remember', value: 'ed2679ccfa8e6b3ab8dc3ec0215363ab', domain: '.vc.ru', path: '/', secure: true, httpOnly: true, expires: 1796120019.910119, sameSite: 'Lax', session: false },
    ]);
    expect(out.localStorage).toEqual(SAMPLE_VAULT_DATA.localStorage);
    expect(out.sessionStorage).toEqual(SAMPLE_VAULT_DATA.sessionStorage);
  });

  it('drops cookies with non-string values', () => {
    const data: VaultEnvelope = {
      cookies: [
        { name: 'ok', value: '1', domain: '.x.com' },
        { name: 'bad', value: 2 as never, domain: '.x.com' },
      ],
    };
    const out = minimalVaultProfile(data);
    expect(out.cookies).toEqual([{ name: 'ok', value: '1', domain: '.x.com' }]);
  });
});

// ── VaultSession.fromPayload ────────────────────────────────────────────────

describe('VaultSession', () => {
  it('wraps a show() payload with decrypted data', () => {
    const s = new VaultSession({ id: '8', label: 'vc.ru', user_id: 1, data: SAMPLE_VAULT_DATA });
    expect(s.id).toBe(8);
    expect(s.label).toBe('vc.ru');
    expect(s.data).toBe(SAMPLE_VAULT_DATA);
    expect(s.urls).toEqual(['https://vc.ru/education_on_vc_ru/3163579']);
  });

  it('pulls urls from the top-level list row when data is a string blob', () => {
    const s = new VaultSession({ id: 8, data: 'encrypted-string', urls: ['https://vc.ru/x'] });
    expect(s.data).toEqual({});
    expect(s.urls).toEqual(['https://vc.ru/x']);
  });
});

// ── ClientVault (HTTP) ────────────────────────────────────────────────────

function mockFetchOnce(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })));
}

function makeClientVault(): ClientVault {
  const client = {
    _apiKey: 'user-token',
    _apiUrl: 'https://api.test',
    _basicAuth: undefined,
  } as never;
  return new ClientVault(client as never);
}

describe('ClientVault', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list() maps a paginated response', async () => {
    mockFetchOnce(200, {
      current_page: 1,
      data: [
        { id: 8, label: 'A', urls: ['https://vc.ru/x'] },
        { id: 5, label: 'B', data: SAMPLE_VAULT_DATA },
      ],
    });
    const vault = makeClientVault();
    const items = await vault.list({ per_page: 10 });
    expect(items.length).toBe(2);
    expect(items[0].id).toBe(8);
    expect(items[1].data).toEqual(SAMPLE_VAULT_DATA);
  });

  it('get() fetches the decrypted envelope', async () => {
    mockFetchOnce(200, { id: 8, data: SAMPLE_VAULT_DATA });
    const vault = makeClientVault();
    const s = await vault.get(8);
    expect(s.id).toBe(8);
    expect(s.data.cookies?.[0]?.name).toBe('auth-refresh-remember');
  });

  it('create() returns the new id', async () => {
    mockFetchOnce(201, { id: 42 });
    const vault = makeClientVault();
    const id = await vault.create(SAMPLE_VAULT_DATA, { label: 'vc' });
    expect(id).toBe(42);
  });

  it('update() PUTs and wraps the response', async () => {
    mockFetchOnce(200, { id: 8, data: SAMPLE_VAULT_DATA });
    const vault = makeClientVault();
    const s = await vault.update(8, SAMPLE_VAULT_DATA, { label: 'new' });
    expect(s.id).toBe(8);
    expect(s.data).toEqual(SAMPLE_VAULT_DATA);
  });

  it('delete() resolves on 204', async () => {
    mockFetchOnce(204, null);
    const vault = makeClientVault();
    await expect(vault.delete(8)).resolves.toBeUndefined();
  });

  it('throws VaultHttpError on non-2xx with server message', async () => {
    mockFetchOnce(403, { message: 'Forbidden' });
    const vault = makeClientVault();
    await expect(vault.get(8)).rejects.toMatchObject({
      name: 'VaultHttpError',
      status: 403,
      message: expect.stringContaining('Forbidden'),
    });
  });

  it('sends X-Basic-Auth when configured', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => null,
      text: async () => '',
    })) as never;
    vi.stubGlobal('fetch', fetcher);
    const client = {
      _apiKey: 'user-token',
      _apiUrl: 'https://api.test',
      _basicAuth: ['user', 'pass'],
    } as never;
    const vault = new ClientVault(client as never);
    await vault.delete(8);
    const call = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Basic-Auth']).toBe('Basic ' + Buffer.from('user:pass').toString('base64'));
  });
});

// ── BrowserVault (save/restore) ───────────────────────────────────────────

function makeStubBrowser() {
  const sent: Record<string, unknown>[] = [];
  const configure = vi.fn(async (opts: unknown) => {
    sent.push({ type: 'session.configure', ...(opts as Record<string, unknown>) });
  });
  const exportProfile = vi.fn(async () => ({
    schema_version: 2,
    fingerprint: { userAgent: 'ua' },
    origin: 'https://vc.ru',
    cookies: [{ name: 'a', value: '1', domain: '.vc.ru', path: '/', size: 4, sourcePort: 443 }],
    localStorage: { user: '{"id":1}' },
    sessionStorage: {},
  }));
  // Real ClientVault — its _request() hits the (globally stubbed) fetch.
  const clientStub = {
    _apiKey: 'user-token',
    _apiUrl: 'https://api.test',
    _basicAuth: undefined,
  } as never;
  const clientVault = new ClientVault(clientStub as never);
  const browser = {
    sessionId: 'sess-1',
    _vaultSessionId: null as number | null,
    _client: { vault: clientVault },
    profile: { export: exportProfile },
    configure,
    _sendRaw: vi.fn(async (msg: Record<string, unknown>) => {
      sent.push(msg);
    }),
  } as never;
  return { browser, sent, exportProfile, configure };
}

describe('BrowserVault', () => {
  it('save() exports the profile and creates a new session', async () => {
    mockFetchOnce(201, { id: 99 });
    const { browser } = makeStubBrowser();
    const vault = new BrowserVault(browser as never);
    const id = await vault.save({ label: 'vc' });
    expect(id).toBe(99);
  });

  it('save() PUTs when browser is bound to a vault id', async () => {
    mockFetchOnce(200, { id: 7, data: {} });
    const { browser } = makeStubBrowser();
    (browser as { _vaultSessionId: number | null })._vaultSessionId = 7;
    const vault = new BrowserVault(browser as never);
    const id = await vault.save(); // no label → overwrite bound id
    expect(id).toBe(7);
  });

  it('save() throws when overwrite requested without a bound id', async () => {
    const { browser } = makeStubBrowser();
    const vault = new BrowserVault(browser as never);
    await expect(vault.save({ overwrite: true })).rejects.toThrow(/no bound vault session/);
  });

  it('restore() normalizes data and calls session.configure(profile) + fingerprint', async () => {
    mockFetchOnce(200, { id: 8, data: SAMPLE_VAULT_DATA });
    const { browser, sent, configure } = makeStubBrowser();
    const vault = new BrowserVault(browser as never);
    await vault.restore(8);
    expect((browser as { _vaultSessionId: number | null })._vaultSessionId).toBe(8);
    expect(configure).toHaveBeenCalledTimes(1);
    const opts = configure.mock.calls[0][0] as { profile: VaultProfile; fingerprint?: Record<string, unknown> };
    expect(opts.fingerprint).toEqual(SAMPLE_VAULT_DATA.fingerprint);
    expect(opts.profile.cookies?.[0]?.name).toBe('auth-refresh-remember');
    expect(opts.profile.localStorage).toEqual(SAMPLE_VAULT_DATA.localStorage);
  });

  it('restore() accepts a raw envelope dict without fetching', async () => {
    const { browser, configure } = makeStubBrowser();
    const vault = new BrowserVault(browser as never);
    await vault.restore(SAMPLE_VAULT_DATA as never);
    expect(configure).toHaveBeenCalledTimes(1);
    // no HTTP involved — fetch was never stubbed, so this is the dict path
  });
});