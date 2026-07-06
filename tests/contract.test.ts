import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ContractClient,
  ContractError,
  parseBenefitable,
  parseParticipant,
  cleanArgs,
  deriveLabel,
  contractIdsFromEnv,
  ROLE_REVIEWER,
  ROLE_QA,
  type HttpClient,
  type HttpResponse,
} from '../src/contract.js';
import { TimelogClient } from '../src/timelog.js';
import {
  parseParticipantSpec,
  parseTagsSpec,
  cmdContract,
  _setContractClientFactory,
  _resetContractClientFactory,
} from '../src/contract-cli.js';

// ── HTTP mock ─────────────────────────────────────────────────────

type Capture = {
  posts: Array<{ url: string; headers: Record<string, string>; body: string }>;
  gets: Array<{ url: string; headers: Record<string, string> }>;
};

function makeHttp(
  payloads: { status?: number; body: unknown } | Array<{ status?: number; body: unknown }>,
): { http: HttpClient; cap: Capture } {
  const seq = Array.isArray(payloads) ? payloads.slice() : [payloads];
  const cap: Capture = { posts: [], gets: [] };
  const next = (): { status: number; body: unknown } => {
    const p = seq.shift() ?? seq[seq.length - 1] ?? { status: 200, body: {} };
    return { status: p.status ?? 200, body: p.body };
  };
  const resp = (status: number, body: unknown): HttpResponse => ({
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
  const http: HttpClient = {
    async post(url, init) {
      cap.posts.push({ url, headers: init.headers, body: init.body });
      const { status, body } = next();
      return resp(status, body);
    },
    async get(url, init) {
      cap.gets.push({ url, headers: init.headers });
      const { status, body } = next();
      return resp(status, body);
    },
  };
  return { http, cap };
}

function mcpText(obj: unknown) {
  return { result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } };
}

function lastArgs(cap: Capture): Record<string, unknown> {
  const body = JSON.parse(cap.posts[cap.posts.length - 1].body);
  return body.params.arguments;
}

function lastBody(cap: Capture): Record<string, unknown> {
  return JSON.parse(cap.posts[cap.posts.length - 1].body);
}

// ── env reset ─────────────────────────────────────────────────────

const ENV_KEYS = [
  'CEKI_AGENT_TOKEN',
  'CEKI_API_KEY',
  'CEKI_API_URL',
  'CEKI_API_BASE',
  'CEKI_AGENT_MCP_ENDPOINT',
  'CEKI_CONTRACT_IDS',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── parseBenefitable / cleanArgs / deriveLabel ────────────────────

describe('parseBenefitable', () => {
  it('parses agent:N', () => {
    expect(parseBenefitable('agent:8')).toEqual({ type: 'agent', value: 8 });
  });
  it('parses user:N', () => {
    expect(parseBenefitable('user:61')).toEqual({ type: 'user', value: 61 });
  });
  it('returns null on null/empty', () => {
    expect(parseBenefitable(null)).toBeNull();
    expect(parseBenefitable('')).toBeNull();
    expect(parseBenefitable(undefined)).toBeNull();
  });
  it('throws on malformed', () => {
    expect(() => parseBenefitable('agent_no_colon')).toThrow();
  });
});

describe('cleanArgs', () => {
  it('drops only undefined and null (keeps 0, false, empty string, [])', () => {
    expect(
      cleanArgs({ a: 0, b: null, c: '', d: false, e: [], f: undefined }),
    ).toEqual({ a: 0, c: '', d: false, e: [] });
  });
});

describe('deriveLabel', () => {
  it('first non-empty line, ≤60 chars', () => {
    expect(deriveLabel('hello world')).toBe('hello world');
    expect(deriveLabel('x'.repeat(200))).toBe('x'.repeat(60));
    expect(deriveLabel('\n\nthird line here')).toBe('third line here');
    expect(deriveLabel('')).toBe('progress');
    expect(deriveLabel(null)).toBe('progress');
    expect(deriveLabel(undefined)).toBe('progress');
  });
});

describe('parseParticipant (helper)', () => {
  it('builds {participable_id, type (short), role_id}', () => {
    expect(parseParticipant('agent:9', ROLE_REVIEWER)).toEqual({
      participable_id: 9,
      type: 'agent',
      role_id: 5,
    });
    expect(parseParticipant('user:42', ROLE_QA)).toEqual({
      participable_id: 42,
      type: 'user',
      role_id: 6,
    });
  });
  it('never returns participable_type (FQCN trap guard)', () => {
    const p = parseParticipant('agent:9', ROLE_REVIEWER)!;
    expect(p).not.toHaveProperty('participable_type');
    expect(p.type).toBe('agent');
  });
});

// ── env resolution ────────────────────────────────────────────────

describe('contractIdsFromEnv', () => {
  it('CSV', () => {
    process.env.CEKI_CONTRACT_IDS = '14,21';
    expect(contractIdsFromEnv()).toEqual(['14', '21']);
  });
  it('bracketed', () => {
    process.env.CEKI_CONTRACT_IDS = '[14,21]';
    expect(contractIdsFromEnv()).toEqual(['14', '21']);
  });
  it('JSON', () => {
    process.env.CEKI_CONTRACT_IDS = '[14, 21]';
    expect(contractIdsFromEnv()).toEqual(['14', '21']);
  });
  it('empty', () => {
    delete process.env.CEKI_CONTRACT_IDS;
    expect(contractIdsFromEnv()).toEqual([]);
  });
});

describe('endpoint resolution', () => {
  it('CEKI_AGENT_MCP_ENDPOINT override', () => {
    process.env.CEKI_AGENT_MCP_ENDPOINT = 'https://x.example/mcp/agent';
    process.env.CEKI_AGENT_TOKEN = 'tok';
    const c = new ContractClient();
    expect(c.endpoint).toBe('https://x.example/mcp/agent');
  });
  it('derived from CEKI_API_URL', () => {
    delete process.env.CEKI_AGENT_MCP_ENDPOINT;
    process.env.CEKI_API_URL = 'https://clawapi.ittribe.org';
    process.env.CEKI_AGENT_TOKEN = 'tok';
    const c = new ContractClient();
    expect(c.endpoint).toBe('https://clawapi.ittribe.org/mcp/agent');
    expect(c.apiBase).toBe('https://clawapi.ittribe.org/api');
  });
});

describe('token resolution', () => {
  it('CEKI_AGENT_TOKEN beats CEKI_API_KEY', () => {
    process.env.CEKI_AGENT_TOKEN = 'ag_xxx';
    process.env.CEKI_API_KEY = 'rental_yyy';
    const c = new ContractClient();
    expect(c.token).toBe('ag_xxx');
  });
  it('falls back to CEKI_API_KEY', () => {
    delete process.env.CEKI_AGENT_TOKEN;
    process.env.CEKI_API_KEY = 'rental_yyy';
    const c = new ContractClient();
    expect(c.token).toBe('rental_yyy');
  });
  it('empty token raises on call', async () => {
    const { http } = makeHttp({ body: mcpText({ ok: true }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: '', http });
    await expect(c.listContracts()).rejects.toThrow(ContractError);
  });
});

// ── MCP unwrapping ────────────────────────────────────────────────

describe('call unwrapping', () => {
  it('unwraps content[].text as JSON', async () => {
    const { http } = makeHttp({ body: mcpText({ items: [1, 2] }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    expect(await c.listContracts()).toEqual({ items: [1, 2] });
  });
  it('returns structuredContent when present', async () => {
    const { http } = makeHttp({ body: { result: { structuredContent: { k: 'v' } } } });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    expect(await c.listContracts()).toEqual({ k: 'v' });
  });
  it('non-200 throws', async () => {
    const { http } = makeHttp({ status: 500, body: { error: 'bad' } });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await expect(c.listContracts()).rejects.toThrow(ContractError);
  });
  it('jsonrpc error throws', async () => {
    const { http } = makeHttp({ body: { error: { code: -32000, message: 'nope' } } });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await expect(c.listContracts()).rejects.toThrow(ContractError);
  });
});

// ── tool calls + payloads ─────────────────────────────────────────

describe('create()', () => {
  it('maps tool name + cleans payload', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'hello', duration: 60, benefitable: 'agent:8' });
    const body = lastBody(cap);
    expect(body.method).toBe('tools/call');
    expect((body.params as Record<string, unknown>).name).toBe('create-contract-event');
    expect(lastArgs(cap)).toEqual({
      contract_id: 14,
      label: 'hello',
      duration: 60,
      benefitable: { type: 'agent', value: 8 },
    });
  });
  it('passes timezone + data + start', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 5 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, {
      label: 'L',
      timezone: 'Europe/Moscow',
      data: { foo: 'bar' },
      start: '2026-06-20 10:00:00',
    });
    const a = lastArgs(cap);
    expect(a.timezone).toBe('Europe/Moscow');
    expect(a.data).toEqual({ foo: 'bar' });
    expect(a.start).toBe('2026-06-20 10:00:00');
  });
  it('emits tags under settings.tags[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 6 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, {
      label: 'L',
      tags: [
        { key: 'backend', label: 'Backend', color: '#ff0000' },
        { key: 'urgent' },
      ],
    });
    expect(lastArgs(cap).settings).toEqual({
      tags: [
        { key: 'backend', label: 'Backend', color: '#ff0000' },
        { key: 'urgent' },
      ],
    });
  });
  it('omits settings when no tags', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 7 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L' });
    expect('settings' in lastArgs(cap)).toBe(false);
  });
});

describe('parseTagsSpec', () => {
  it('bare comma-separated keys', () => {
    expect(parseTagsSpec('backend,urgent')).toEqual([
      { key: 'backend' },
      { key: 'urgent' },
    ]);
  });
  it('key:label:color', () => {
    expect(parseTagsSpec('backend:Backend:#ff0000')).toEqual([
      { key: 'backend', label: 'Backend', color: '#ff0000' },
    ]);
  });
  it('empty label skipped (key::#color)', () => {
    expect(parseTagsSpec('docs::#0af')).toEqual([{ key: 'docs', color: '#0af' }]);
  });
  it('trims and ignores blank items', () => {
    expect(parseTagsSpec(' backend , , qa ')).toEqual([
      { key: 'backend' },
      { key: 'qa' },
    ]);
  });
  it('throws when an item has no key', () => {
    expect(() => parseTagsSpec(':nope')).toThrow();
  });
  it('throws when nothing parses', () => {
    expect(() => parseTagsSpec(' , , ')).toThrow();
  });
});

describe('comment()', () => {
  it('strips undefined', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 99 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.comment(99, { label: 'done', duration: 30 });
    const a = lastArgs(cap);
    expect(a).toEqual({ event_id: 99, label: 'done', duration: 30 });
    expect(a).not.toHaveProperty('amount');
    expect(a).not.toHaveProperty('currency');
    expect(a).not.toHaveProperty('benefitable');
  });
  it('passes start/end/date', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.comment(7, { label: 'x', start: 's', end: 'e', date: '2026-06-18' });
    const a = lastArgs(cap);
    expect(a.start).toBe('s');
    expect(a.end).toBe('e');
    expect(a.date).toBe('2026-06-18');
  });
});

describe('propose()', () => {
  it('maps tool + arguments', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.propose(7, { status: 200, label: 'L' });
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('propose-correction');
    expect(lastArgs(cap)).toEqual({ event_id: 7, status_id: 200, label: 'L' });
  });
  it('passes start/end/date', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.propose(7, { status: 200, start: 's', end: 'e', date: '2026-06-18' });
    const a = lastArgs(cap);
    expect(a.start).toBe('s');
    expect(a.end).toBe('e');
    expect(a.date).toBe('2026-06-18');
  });
  it('forwards settings.tags verbatim (ev 2796 / 2807)', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.propose(7, {
      status: 222,
      settings: {
        tags: [
          { key: 'backend' },
          { key: 'ui', label: 'UI' },
          { key: 'bug', label: 'Bug', color: 'red' },
        ],
        reply_to: 42,
        blocked_by: [9, 10],
        do_after: '2026-07-04T00:00:00Z',
      },
    });
    expect(lastArgs(cap).settings).toEqual({
      tags: [
        { key: 'backend' },
        { key: 'ui', label: 'UI' },
        { key: 'bug', label: 'Bug', color: 'red' },
      ],
      reply_to: 42,
      blocked_by: [9, 10],
      do_after: '2026-07-04T00:00:00Z',
    });
  });
  it('omits settings when not supplied', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.propose(7, { status: 222 });
    expect('settings' in lastArgs(cap)).toBe(false);
  });
});

describe('vote()', () => {
  it('payload shape', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.vote(7, [1, 2], true);
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('vote-correction');
    expect(lastArgs(cap)).toEqual({ event_id: 7, ids: [1, 2], vote: true });
  });
});

describe('history()', () => {
  it('tool name + no-limit omits field', async () => {
    const { http, cap } = makeHttp({ body: mcpText([]) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.history(42);
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('get-event-history');
    expect(lastArgs(cap)).toEqual({ event_id: 42 });
  });
  it('passes limit', async () => {
    const { http, cap } = makeHttp({ body: mcpText([]) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.history(42, { limit: 10 });
    expect(lastArgs(cap)).toEqual({ event_id: 42, limit: 10 });
  });
});

// ── wire-name swap regression guards ─────────────────────────────
//
// Backend swapped:
//   get-my-jobs   (formerly contract tasks)      → get-my-events
//   get-hire-jobs (formerly posted hire jobs)    → get-my-jobs
//
// SDK semantics:
//   myEvents() = contract events assigned to me (calls get-my-events)
//   myJobs()   = hire schedules I posted        (calls get-my-jobs)

describe('myEvents() / myJobs() wire-name swap', () => {
  it('myEvents() calls get-my-events with no args (plate feed)', async () => {
    const { http, cap } = makeHttp({ body: mcpText([]) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.myEvents();
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('get-my-events');
    expect(lastArgs(cap)).toEqual({});
  });
  it('myJobs() calls get-my-jobs with no args (hire-schedule listings)', async () => {
    const { http, cap } = makeHttp({ body: mcpText([]) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.myJobs();
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('get-my-jobs');
    expect(lastArgs(cap)).toEqual({});
  });
});

// ── polling ───────────────────────────────────────────────────────

describe('poll()', () => {
  it('returns list directly', async () => {
    const { http } = makeHttp({ body: [{ x: 1 }, { x: 2 }] });
    const c = new ContractClient({
      endpoint: 'http://x/mcp/agent',
      apiBase: 'http://x/api',
      token: 't',
      http,
    });
    expect(await c.poll()).toEqual([{ x: 1 }, { x: 2 }]);
  });
  it('unwraps notifications key', async () => {
    const { http } = makeHttp({ body: { notifications: [{ a: 1 }] } });
    const c = new ContractClient({
      endpoint: 'http://x/mcp/agent',
      apiBase: 'http://x/api',
      token: 't',
      http,
    });
    expect(await c.poll()).toEqual([{ a: 1 }]);
  });
  it('429 returns []', async () => {
    const { http } = makeHttp({ status: 429, body: { error: 'rate' } });
    const c = new ContractClient({
      endpoint: 'http://x/mcp/agent',
      apiBase: 'http://x/api',
      token: 't',
      http,
    });
    expect(await c.poll()).toEqual([]);
  });
  it('5xx throws', async () => {
    const { http } = makeHttp({ status: 500, body: { error: 'boom' } });
    const c = new ContractClient({
      endpoint: 'http://x/mcp/agent',
      apiBase: 'http://x/api',
      token: 't',
      http,
    });
    await expect(c.poll()).rejects.toThrow(ContractError);
  });
});

// ── users[] payload regression guards (back/2542) ─────────────────

describe('users[] payload (back/2542 rename)', () => {
  it('reviewer folds into users[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', reviewer: 'agent:9' });
    const a = lastArgs(cap);
    expect(a.users).toEqual([{ participable_id: 9, type: 'agent', role_id: 5 }]);
    expect(a).not.toHaveProperty('reviewer');
    expect(a).not.toHaveProperty('qa');
    expect(a).not.toHaveProperty('participants');
  });
  it('qa folds into users[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', qa: 'user:42' });
    const a = lastArgs(cap);
    expect(a.users).toEqual([{ participable_id: 42, type: 'user', role_id: 6 }]);
    expect(a).not.toHaveProperty('reviewer');
    expect(a).not.toHaveProperty('qa');
    expect(a).not.toHaveProperty('participants');
  });
  it('reviewer + qa both in users[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', reviewer: 'agent:9', qa: 'agent:12' });
    const a = lastArgs(cap);
    const users = a.users as Array<Record<string, unknown>>;
    expect(users).toHaveLength(2);
    const byRole = Object.fromEntries(users.map((p) => [p.role_id, p]));
    expect(byRole[5]).toEqual({ participable_id: 9, type: 'agent', role_id: 5 });
    expect(byRole[6]).toEqual({ participable_id: 12, type: 'agent', role_id: 6 });
    expect(a).not.toHaveProperty('participants');
  });
  it('element uses `type` (short) NOT participable_type (FQCN)', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', reviewer: 'agent:9', qa: 'agent:12' });
    const users = lastArgs(cap).users as Array<Record<string, unknown>>;
    for (const p of users) {
      expect(p).toHaveProperty('participable_id');
      expect(p).toHaveProperty('type');
      expect(p).toHaveProperty('role_id');
      expect(p).not.toHaveProperty('participable_type');
      expect(p).not.toHaveProperty('value');
      expect(String(p.type)).not.toContain('\\');
      expect(String(p.type)).not.toContain('App\\');
    }
  });
  it('wire key is `users` not `participants`', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', reviewer: 'agent:9', qa: 'user:42' });
    const a = lastArgs(cap);
    expect(a).toHaveProperty('users');
    expect(a).not.toHaveProperty('participants');
  });
  it('no reviewer/qa → no users key', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', benefitable: 'agent:8' });
    const a = lastArgs(cap);
    expect(a).not.toHaveProperty('users');
    expect(a).not.toHaveProperty('participants');
    expect(a).not.toHaveProperty('reviewer');
    expect(a).not.toHaveProperty('qa');
    expect(a.benefitable).toEqual({ type: 'agent', value: 8 });
  });
  it('benefitable stays top-level alongside users[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, { label: 'L', benefitable: 'agent:8', reviewer: 'agent:9' });
    const a = lastArgs(cap);
    expect(a.benefitable).toEqual({ type: 'agent', value: 8 });
    expect(a.users).toEqual([{ participable_id: 9, type: 'agent', role_id: 5 }]);
    expect(a).not.toHaveProperty('participants');
  });
  it('reviewer + extra participant stack on users[]', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ id: 1 }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.create(14, {
      label: 'L',
      reviewer: 'agent:9',
      participants: [{ participable_id: 5, type: 'agent', role_id: 5 }],
    });
    const a = lastArgs(cap);
    const users = a.users as Array<Record<string, unknown>>;
    expect(users).toHaveLength(2);
    expect(users.every((p) => p.role_id === 5)).toBe(true);
    expect(users.map((p) => p.participable_id).sort()).toEqual([5, 9]);
    expect(a).not.toHaveProperty('participants');
  });
});

// ── progress (status correction + comment) ────────────────────────

describe('progress()', () => {
  it('status+desc → propose(status) then comment(label+desc)', async () => {
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't' });
    const calls: Array<{ name: string; eid: number; args: Record<string, unknown> }> = [];
    vi.spyOn(c, 'propose').mockImplementation(async (eid: number, args = {}) => {
      calls.push({ name: 'propose', eid, args });
      return { applied: true, id: 1 };
    });
    vi.spyOn(c, 'comment').mockImplementation(async (eid: number, args = {}) => {
      calls.push({ name: 'comment', eid, args });
      return { id: 2 };
    });
    const result = await c.progress(99, { status: 222, desc: 'r' });
    expect(calls.map((c) => c.name)).toEqual(['propose', 'comment']);
    expect(calls[0].eid).toBe(99);
    expect(calls[0].args).toEqual({ status: 222 });
    expect(calls[1].eid).toBe(99);
    expect(calls[1].args).toEqual({ label: 'r', description: 'r' });
    expect(result).toEqual({
      status_correction: { applied: true, id: 1 },
      comment: { id: 2 },
    });
  });
  it('desc-only → comment, propose never called', async () => {
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't' });
    const proposeSpy = vi.spyOn(c, 'propose').mockResolvedValue({ applied: true });
    const commentSpy = vi.spyOn(c, 'comment').mockResolvedValue({ id: 7 });
    const result = await c.progress(99, { desc: 'just an update' });
    expect(proposeSpy).not.toHaveBeenCalled();
    expect(commentSpy).toHaveBeenCalledTimes(1);
    expect(commentSpy.mock.calls[0]).toEqual([
      99,
      { label: 'just an update', description: 'just an update' },
    ]);
    expect(result).toEqual({ status_correction: null, comment: { id: 7 } });
  });
  it('NEVER passes desc/description/label to propose', async () => {
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't' });
    const proposeSpy = vi.spyOn(c, 'propose').mockResolvedValue({ applied: true });
    vi.spyOn(c, 'comment').mockResolvedValue({ id: 1 });
    await c.progress(99, { status: 222, desc: 'this is a progress report, NOT a spec' });
    expect(proposeSpy).toHaveBeenCalledTimes(1);
    const args = proposeSpy.mock.calls[0][1]!;
    expect(args).toHaveProperty('status');
    expect(args).not.toHaveProperty('desc');
    expect(args).not.toHaveProperty('description');
    expect(args).not.toHaveProperty('label');
  });
  it('label derived from desc, ≤60 chars', async () => {
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't' });
    vi.spyOn(c, 'propose').mockResolvedValue({ applied: true });
    const commentSpy = vi.spyOn(c, 'comment').mockResolvedValue({ id: 1 });
    const longDesc = 'x'.repeat(200) + '\nsecond line';
    await c.progress(99, { desc: longDesc });
    const args = commentSpy.mock.calls[0][1]!;
    expect(args.label).toBeDefined();
    expect(String(args.label).length).toBeLessThanOrEqual(60);
    expect(args.label).toBe('x'.repeat(60));
    expect(args.description).toBe(longDesc);
  });
});

// ── tools/raw ────────────────────────────────────────────────────

describe('tools/raw', () => {
  it('tools/list → names array', async () => {
    const { http } = makeHttp({
      body: { result: { tools: [{ name: 'a' }, { name: 'b' }] } },
    });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    expect(await c.tools()).toEqual(['a', 'b']);
  });
  it('raw maps to tools/call with args', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ ok: true }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.raw('whatever', { x: 1 });
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('whatever');
    expect(lastArgs(cap)).toEqual({ x: 1 });
  });
});

// ── auth header ─────────────────────────────────────────────────

describe('auth headers', () => {
  it('Authorization: Bearer <token> on POST', async () => {
    const { http, cap } = makeHttp({ body: mcpText({}) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't0k', http });
    await c.listContracts();
    expect(cap.posts[0].headers.Authorization).toBe('Bearer t0k');
    expect(cap.posts[0].headers['Content-Type']).toBe('application/json');
  });
  it('Authorization on GET poll', async () => {
    const { http, cap } = makeHttp({ body: [] });
    const c = new ContractClient({
      endpoint: 'http://x/mcp/agent',
      apiBase: 'http://x/api',
      token: 't0k',
      http,
    });
    await c.poll();
    expect(cap.gets[0].headers.Authorization).toBe('Bearer t0k');
    expect(cap.gets[0].url).toBe('http://x/api/agent/polling');
  });
});

// ── timelog ──────────────────────────────────────────────────────

describe('TimelogClient', () => {
  it('start → timelog-start with event_id', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ ok: true }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    const tl = new TimelogClient({ contract: c });
    await tl.start(99);
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('timelog-start');
    expect(lastArgs(cap)).toEqual({ event_id: 99 });
  });
  it('stop with label', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ ok: true }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    const tl = new TimelogClient({ contract: c });
    await tl.stop(99, 'done');
    expect(lastArgs(cap)).toEqual({ event_id: 99, label: 'done' });
  });
  it('stop without label omits it', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ ok: true }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    const tl = new TimelogClient({ contract: c });
    await tl.stop(99);
    expect(lastArgs(cap)).toEqual({ event_id: 99 });
  });
  it('check', async () => {
    const { http, cap } = makeHttp({ body: mcpText({ open: false }) });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    const tl = new TimelogClient({ contract: c });
    await tl.check(77);
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('timelog-check');
    expect(lastArgs(cap)).toEqual({ event_id: 77 });
  });
});

// ── CLI parser: parseParticipantSpec ─────────────────────────────

describe('parseParticipantSpec', () => {
  it('agent:5:reviewer → role 5', () => {
    expect(parseParticipantSpec('agent:5:reviewer')).toEqual({
      participable_id: 5,
      type: 'agent',
      role_id: 5,
    });
  });
  it('user:7:qa → role 6', () => {
    expect(parseParticipantSpec('user:7:qa')).toEqual({
      participable_id: 7,
      type: 'user',
      role_id: 6,
    });
  });
  it('agent:5:role:42 → numeric role', () => {
    expect(parseParticipantSpec('agent:5:role:42')).toEqual({
      participable_id: 5,
      type: 'agent',
      role_id: 42,
    });
  });
  it('unknown role rejected', () => {
    expect(() => parseParticipantSpec('agent:5:bogus')).toThrow(/unknown role/);
  });
  it('bad type rejected', () => {
    expect(() => parseParticipantSpec('robot:5:reviewer')).toThrow(/type/);
  });
});

// ── call-human (task 4019) ────────────────────────────────────────

describe('callHuman()', () => {
  it('wires tool name "call-human" with {event_id, kind, desc}', async () => {
    const { http, cap } = makeHttp({
      body: mcpText({
        recipients: [], dispatched: 0, deep_link: 'u', kind: 'stuck',
      }),
    });
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't', http });
    await c.callHuman(99, 'stuck', 'body');
    const body = lastBody(cap);
    expect((body.params as Record<string, unknown>).name).toBe('call-human');
    expect(lastArgs(cap)).toEqual({ event_id: 99, kind: 'stuck', desc: 'body' });
  });

  it('rejects kinds outside the enum', async () => {
    const c = new ContractClient({ endpoint: 'http://x/mcp/agent', token: 't' });
    await expect(
      c.callHuman(99, 'urgent' as unknown as 'stuck', 'body'),
    ).rejects.toThrow(/kind must be/);
    await expect(
      c.callHuman(99, '' as unknown as 'stuck', 'body'),
    ).rejects.toThrow(/kind must be/);
  });
});

describe('CLI: contract call-human', () => {
  afterEach(() => {
    _resetContractClientFactory();
  });

  it('parses positional event_id + --kind + --desc and dispatches to client.callHuman', async () => {
    const captured: {
      eid?: number;
      kind?: string;
      desc?: string;
    } = {};
    const fake = {
      async callHuman(eid: number, kind: string, desc: string) {
        captured.eid = eid;
        captured.kind = kind;
        captured.desc = desc;
        return {
          recipients: [{ user_id: 1, label: 'L', reason: 'R' }],
          dispatched: 1,
          deep_link: 'https://ex/e/42',
          kind: 'review',
        };
      },
    } as unknown as ContractClient;
    _setContractClientFactory(() => fake);

    const rc = await cmdContract([
      'call-human', '42', '--kind', 'review', '--desc', 'why',
    ]);
    expect(rc).toBe(0);
    expect(captured).toEqual({ eid: 42, kind: 'review', desc: 'why' });
  });

  it('missing --kind fails with rc=1 and does not touch client', async () => {
    let called = false;
    _setContractClientFactory(
      () => ({
        async callHuman() {
          called = true;
          return {};
        },
      }) as unknown as ContractClient,
    );
    const rc = await cmdContract(['call-human', '42', '--desc', 'why']);
    expect(rc).toBe(1);
    expect(called).toBe(false);
  });

  it('missing --desc fails with rc=1 and does not touch client', async () => {
    let called = false;
    _setContractClientFactory(
      () => ({
        async callHuman() {
          called = true;
          return {};
        },
      }) as unknown as ContractClient,
    );
    const rc = await cmdContract(['call-human', '42', '--kind', 'review']);
    expect(rc).toBe(1);
    expect(called).toBe(false);
  });

  it('missing event_id fails with rc=1', async () => {
    let called = false;
    _setContractClientFactory(
      () => ({
        async callHuman() {
          called = true;
          return {};
        },
      }) as unknown as ContractClient,
    );
    const rc = await cmdContract(['call-human', '--kind', 'review', '--desc', 'why']);
    expect(rc).toBe(1);
    expect(called).toBe(false);
  });

  it('bad --kind is rejected client-side (does not reach the wire)', async () => {
    let called = false;
    _setContractClientFactory(
      () => ({
        async callHuman() {
          called = true;
          return {};
        },
      }) as unknown as ContractClient,
    );
    const rc = await cmdContract([
      'call-human', '42', '--kind', 'urgent', '--desc', 'why',
    ]);
    expect(rc).toBe(1);
    expect(called).toBe(false);
  });
});
