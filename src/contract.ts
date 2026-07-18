// Client for /mcp/agent contract tools (1:1 port of python-sdk ContractClient).

import { defaults } from './config.js';

// Contract role IDs (back/2542 users[] payload — renamed from participants[]).
export const ROLE_REVIEWER = 5;
export const ROLE_QA = 6;

export type Benefitable = { type: string; value: number };
export type ParticipantSpec = {
  participable_id: number;
  type: 'agent' | 'user' | string;
  role_id: number;
};

/** Project tag element persisted under events.settings.tags[] (back/3165). */
export type TagSpec = {
  key: string;
  label?: string;
  color?: string;
};

/**
 * Settings blob forwarded verbatim into propose-correction arguments
 * (and create-contract-event). Carries tags, the dependency graph
 * (reply_to / blocked_by / do_after) that the backend (ev 2796 c46)
 * persists onto the event's `settings` column.
 */
export type ContractSettings = {
  tags?: TagSpec[];
  /** event id this correction replies to. */
  reply_to?: number;
  /** event ids that must resolve before this one. */
  blocked_by?: number[];
  /** ISO datetime — do not start until this timestamp passes. */
  do_after?: string;
};

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

/** Parse 'agent:N' / 'user:N' into {type, value}. Throws on malformed input.
 *
 * Also accepts special markers:
 *   'creator' — resolves to event.user_id  (client-side, see _resolveUsers)
 *   'owner'   — resolves to contract.owner_id (client-side, see _resolveUsers)
 */
export function parseBenefitable(value: string | null | undefined): Benefitable | null {
  if (value === null || value === undefined || value === '') return null;

  // Special markers for client-side resolution
  if (value === 'creator' || value === 'owner') {
    return { type: value, value: 0 };
  }

  const parts = String(value).split(':');
  if (parts.length !== 2) {
    throw new Error(`benefitable must be 'type:id', got: ${JSON.stringify(value)}`);
  }
  const [btype, bid] = parts;
  const num = Number.parseInt(bid, 10);
  if (!Number.isFinite(num) || Number.isNaN(num)) {
    throw new Error(`benefitable id must be int, got: ${JSON.stringify(bid)}`);
  }
  return { type: btype, value: num };
}

/** Parse 'agent:N' / 'user:N' / 'creator' / 'owner' into ParticipantSpec.
 *
 * Wire shape declared by the create-contract-event MCP tool schema:
 * `participable_id` + `type` (short token: 'agent' or 'user') + `role_id`.
 * The MCP tool drops any field it does not know about, so sending
 * `participable_type` (FQCN) silently loses the type and the backend
 * membership lookup defaults to user → misleading 422 "Participant must
 * be a member of the contract". Send `type`.
 *
 * Special markers 'creator' and 'owner' are NOT resolved here — they pass
 * through as markers (participable_id: 0) and are resolved client-side
 * in create() / propose() via _resolveUsers().
 */
export function parseParticipant(
  value: string | null | undefined,
  roleId: number,
): ParticipantSpec | null {
  const base = parseBenefitable(value);
  if (base === null) return null;
  // Special markers pass through for client-side resolution
  if (base.type === 'creator' || base.type === 'owner') {
    return { participable_id: 0, type: base.type, role_id: roleId };
  }
  return {
    participable_id: base.value,
    type: base.type as 'agent' | 'user',
    role_id: roleId,
  };
}

/** Strip undefined and null values; keep 0, false, '', [], {}. */
export function cleanArgs<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

const MAX_LABEL_LENGTH = 1024;

/** Split long label/description at word boundary (max 1024 chars for label).
 *
 * Mirrors python-sdk _split_label_desc().
 * - Both None → (None, None)
 * - Only label, ≤1024 → (label, None)
 * - Only label, >1024 → split at word boundary → (first part, rest as description)
 * - Only description → if ≤1024 becomes label with no description, else split
 * - Both set → as-is
 */
export function splitLabelDesc(
  label: string | null | undefined,
  description: string | null | undefined,
): { label: string | undefined; description: string | undefined } {
  const lbl = label ?? undefined;
  const desc = description ?? undefined;

  if (!lbl && !desc) return { label: undefined, description: undefined };

  // Both set — use as-is
  if (lbl && desc) return { label: lbl, description: desc };

  const text = (lbl ?? desc)!;

  if (text.length <= MAX_LABEL_LENGTH) {
    // Only description → becomes label (no desc). Only label, short → as-is.
    return lbl ? { label: lbl, description: undefined } : { label: text, description: undefined };
  }

  // Text > 1024 — split at word boundary (mirrors python word_boundary)
  const splitAt = text.lastIndexOf(' ', MAX_LABEL_LENGTH);
  const effectiveSplit = splitAt > 0 ? splitAt : MAX_LABEL_LENGTH;
  const first = text.slice(0, effectiveSplit);
  const rest = text.slice(effectiveSplit).trim() || undefined;

  return { label: first, description: rest };
}

/** Derive a short (<=60 char) label from a desc's first non-empty line. */
export function deriveLabel(desc: string | null | undefined): string {
  if (!desc) return 'progress';
  const lines = String(desc).split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (t) return t.slice(0, 60);
  }
  return 'progress';
}

export function contractIdsFromEnv(): string[] {
  const raw = (process.env.CEKI_CONTRACT_IDS ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  } catch {
    /* fall through */
  }
  return raw
    .replace(/\[/g, '')
    .replace(/\]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveEndpoint(): string {
  const override = process.env.CEKI_AGENT_MCP_ENDPOINT;
  if (override) return override.replace(/\/+$/, '');
  const base = (process.env.CEKI_API_URL ?? defaults.apiUrl).replace(/\/+$/, '');
  return `${base}/mcp/agent`;
}

function resolveApiBase(): string {
  const override = process.env.CEKI_API_BASE;
  if (override) return override.replace(/\/+$/, '');
  const base = (process.env.CEKI_API_URL ?? defaults.apiUrl).replace(/\/+$/, '');
  return `${base}/api`;
}

function resolveToken(): string {
  return process.env.CEKI_AGENT_TOKEN ?? process.env.CEKI_API_KEY ?? '';
}

// Wire names swapped on the backend:
//   get-my-jobs   (formerly contract tasks)      → get-my-events
//   get-hire-jobs (formerly posted hire jobs)    → get-my-jobs
// The two sugar keys reflect the new, non-cross-contaminated semantics:
//   'my-events' = contract events assigned to me  (the plate feed)
//   'my-jobs'   = hire schedules I posted (type 3) (the listings feed)
const TOOL_MAP = {
  list: 'get-my-contracts',
  members: 'get-contract-members',
  tasks: 'get-contract-events',
  'my-events': 'get-my-events',
  'my-jobs': 'get-my-jobs',
  task: 'get-event',
  children: 'get-event-children',
  history: 'get-event-history',
  create: 'create-contract-event',
  comment: 'comment',
  propose: 'propose-correction',
  vote: 'vote-correction',
} as const;

/** Injectable HTTP transport — vitest swaps this out in tests. */
export type HttpResponse = {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export interface HttpClient {
  post(
    url: string,
    init: { headers: Record<string, string>; body: string },
  ): Promise<HttpResponse>;
  get(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse>;
}

class FetchHttpClient implements HttpClient {
  constructor(private timeoutMs: number) {}
  private withTimeout(): { signal: AbortSignal; cancel: () => void } {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    return { signal: ctl.signal, cancel: () => clearTimeout(t) };
  }
  async post(
    url: string,
    init: { headers: Record<string, string>; body: string },
  ): Promise<HttpResponse> {
    const { signal, cancel } = this.withTimeout();
    try {
      const r = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal });
      const text = await r.text();
      return {
        status: r.status,
        text: async () => text,
        json: async () => {
          try {
            return JSON.parse(text);
          } catch {
            return { raw: text };
          }
        },
      };
    } finally {
      cancel();
    }
  }
  async get(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse> {
    const { signal, cancel } = this.withTimeout();
    try {
      const r = await fetch(url, { method: 'GET', headers: init.headers, signal });
      const text = await r.text();
      return {
        status: r.status,
        text: async () => text,
        json: async () => {
          try {
            return JSON.parse(text);
          } catch {
            return { raw: text };
          }
        },
      };
    } finally {
      cancel();
    }
  }
}

export type ContractClientOptions = {
  endpoint?: string;
  apiBase?: string;
  token?: string;
  http?: HttpClient;
  timeoutMs?: number;
};

export type CreateOptions = {
  label: string;
  type?: number;
  status?: number;
  kalScheduleId?: number;
  start?: string;
  end?: string;
  timezone?: string;
  date?: string;
  duration?: number;
  amount?: number;
  currency?: string;
  description?: string;
  data?: Record<string, unknown>;
  benefitable?: string;
  reviewer?: string;
  qa?: string;
  participants?: ParticipantSpec[];
  /** Sugar for settings.tags[] — {key, label?, color?} project tags. */
  tags?: TagSpec[];
};

export type CommentOptions = {
  label?: string;
  type?: number;
  status?: number;
  start?: string;
  end?: string;
  date?: string;
  duration?: number;
  amount?: number;
  currency?: string;
  description?: string;
  benefitable?: string;
};

export type ProposeOptions = {
  status?: number;
  label?: string;
  description?: string;
  start?: string;
  end?: string;
  date?: string;
  duration?: number;
  amount?: number;
  currency?: string;
  benefitable?: string;
  /** Agent or user spec for reviewer role, e.g. 'agent:5' or 'owner'. */
  reviewer?: string;
  /** Agent or user spec for QA role, e.g. 'user:12' or 'creator'. */
  qa?: string;
  /** Extra participant specs (beyond reviewer/qa). */
  participants?: ParticipantSpec[];
  /** Settings blob (tags, reply_to, blocked_by, do_after) — forwarded
   *  verbatim into the propose-correction wire payload. 2807 / ev 2796. */
  settings?: ContractSettings;
};

export type ProgressOptions = {
  status?: number;
  desc: string;
};

export type ProgressResult = {
  status_correction: unknown;
  comment: unknown;
};

export class ContractClient {
  readonly endpoint: string;
  readonly apiBase: string;
  readonly token: string;
  private http: HttpClient;

  constructor(opts: ContractClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? resolveEndpoint()).replace(/\/+$/, '');
    this.apiBase = (opts.apiBase ?? resolveApiBase()).replace(/\/+$/, '');
    this.token = opts.token !== undefined ? opts.token : resolveToken();
    this.http = opts.http ?? new FetchHttpClient(opts.timeoutMs ?? 30000);
  }

  private headers(): Record<string, string> {
    if (!this.token) {
      throw new ContractError('agent token not set (CEKI_AGENT_TOKEN or CEKI_API_KEY)');
    }
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });
    const resp = await this.http.post(this.endpoint, { headers: this.headers(), body });
    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      parsed = { raw: await resp.text() };
    }
    if (resp.status !== 200) {
      const snippet = JSON.stringify(parsed).slice(0, 400);
      throw new ContractError(`HTTP ${resp.status}: ${snippet}`);
    }
    return (parsed as Record<string, unknown>) ?? {};
  }

  /** Call MCP tool; unwrap content[].text (JSON-parsed) or structuredContent. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const body = await this.rpc('tools/call', { name: tool, arguments: args });
    if (body['error']) {
      throw new ContractError(`${tool} → ${JSON.stringify(body['error']).slice(0, 400)}`);
    }
    const result = (body['result'] as Record<string, unknown>) ?? {};
    const content = result['content'];
    if (Array.isArray(content)) {
      const texts = content
        .filter((c) => (c as Record<string, unknown>)['type'] === 'text')
        .map((c) => String((c as Record<string, unknown>)['text'] ?? ''));
      const joined = texts.join('\n');
      try {
        return JSON.parse(joined);
      } catch {
        return joined;
      }
    }
    if (result['structuredContent'] !== undefined) return result['structuredContent'];
    return result;
  }

  async tools(): Promise<unknown> {
    const body = await this.rpc('tools/list', {});
    const result = (body['result'] as Record<string, unknown>) ?? {};
    const tools = result['tools'];
    if (Array.isArray(tools)) return tools.map((t) => (t as Record<string, unknown>)['name']);
    return body;
  }

  async raw(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.call(tool, args);
  }

  // ── domain helpers ──────────────────────────────────────────────

  async listContracts(): Promise<unknown> {
    return this.call(TOOL_MAP.list, {});
  }

  async members(contractId: number): Promise<unknown> {
    return this.call(TOOL_MAP.members, { contract_id: Number(contractId) });
  }

  async tasks(contractId: number): Promise<unknown> {
    return this.call(TOOL_MAP.tasks, { contract_id: Number(contractId) });
  }

  /** Contract events assigned to me — the agent's plate feed.
   *
   * Calls `get-my-events` (formerly `get-my-jobs`; backend renamed
   * the wire tool when the listings feed reclaimed `get-my-jobs`).
   */
  async myEvents(): Promise<unknown> {
    return this.call(TOOL_MAP['my-events'], {});
  }

  /** Escalate to a human up the event→parent→contract→schedule chain.
   *
   * Wraps the `call-human` MCP tool. Returns
   * `{recipients:[{user_id,label,reason}], dispatched:<int>,
   * deep_link:"<url>", kind:"<kind>"}`.
   */
  async callHuman(
    eventId: number,
    kind: 'input' | 'review' | 'stuck',
    desc: string,
  ): Promise<unknown> {
    if (!['input', 'review', 'stuck'].includes(kind)) {
      throw new Error(
        `kind must be 'input' | 'review' | 'stuck', got ${JSON.stringify(kind)}`,
      );
    }
    return this.call('call-human', {
      event_id: Number(eventId),
      kind,
      desc,
    });
  }

  /** Hire schedules I posted (type 3) — the listings feed.
   *
   * Calls `get-my-jobs` (the wire name was reused for this semantic
   * after the backend swap; previously this method returned contract
   * events — use `myEvents()` for that now).
   */
  async myJobs(): Promise<unknown> {
    return this.call(TOOL_MAP['my-jobs'], {});
  }

  async task(eventId: number): Promise<unknown> {
    return this.call(TOOL_MAP.task, { event_id: Number(eventId) });
  }

  async children(eventId: number): Promise<unknown> {
    return this.call(TOOL_MAP.children, { event_id: Number(eventId) });
  }

  async history(eventId: number, opts: { limit?: number } = {}): Promise<unknown> {
    const args = cleanArgs({ event_id: Number(eventId), limit: opts.limit });
    return this.call(TOOL_MAP.history, args as Record<string, unknown>);
  }

  async create(contractId: number, opts: CreateOptions): Promise<unknown> {
    // back/2542: reviewer/qa now live inside users[] (renamed from
    // participants[]). Element shape unchanged. The `participants`
    // option name is kept as a stable SDK API for callers, but on
    // the wire it is emitted under the `users` key.
    const users: ParticipantSpec[] = [];
    const rev = parseParticipant(opts.reviewer, ROLE_REVIEWER);
    if (rev !== null) users.push(rev);
    const qa = parseParticipant(opts.qa, ROLE_QA);
    if (qa !== null) users.push(qa);
    if (opts.participants && opts.participants.length) {
      users.push(...opts.participants);
    }
    // Resolve creator/owner markers before sending
    const resolvedUsers = await this._resolveUsers(users, undefined, contractId);

    const args = cleanArgs({
      contract_id: Number(contractId),
      label: opts.label,
      type_id: opts.type,
      status_id: opts.status,
      kal_schedule_id: opts.kalScheduleId,
      start: opts.start,
      end: opts.end,
      timezone: opts.timezone,
      date: opts.date,
      duration: opts.duration,
      amount: opts.amount,
      currency: opts.currency,
      description: opts.description,
      data: opts.data,
      benefitable: opts.benefitable !== undefined ? parseBenefitable(opts.benefitable) : undefined,
      users: resolvedUsers.length > 0 ? resolvedUsers : undefined,
      // back/3165: project tags live in events.settings.tags[]. `tags` is
      // SDK/CLI sugar — emitted on the wire under the `settings` blob.
      settings: opts.tags && opts.tags.length ? { tags: opts.tags } : undefined,
    });
    return this.call(TOOL_MAP.create, args as Record<string, unknown>);
  }

  async comment(eventId: number, opts: CommentOptions = {}): Promise<unknown> {
    const { label, description } = splitLabelDesc(opts.label, opts.description);
    const args = cleanArgs({
      event_id: Number(eventId),
      label,
      type_id: opts.type,
      status_id: opts.status,
      start: opts.start,
      end: opts.end,
      date: opts.date,
      duration: opts.duration,
      amount: opts.amount,
      currency: opts.currency,
      description,
      benefitable: opts.benefitable !== undefined ? parseBenefitable(opts.benefitable) : undefined,
    });
    return this.call(TOOL_MAP.comment, args as Record<string, unknown>);
  }

  async propose(eventId: number, opts: ProposeOptions = {}): Promise<unknown> {
    // propose is a correction/PATCH — label and description are independent
    // fields. Do NOT use splitLabelDesc (which maps desc→label when label is
    // absent) — that would make --desc set the label instead of description.
    //
    // reviewer/qa/participants build users[] the same way as create().
    const users: ParticipantSpec[] = [];
    const rev = parseParticipant(opts.reviewer, ROLE_REVIEWER);
    if (rev !== null) users.push(rev);
    const qa = parseParticipant(opts.qa, ROLE_QA);
    if (qa !== null) users.push(qa);
    if (opts.participants && opts.participants.length) {
      users.push(...opts.participants);
    }
    // Resolve creator/owner markers before sending
    const resolvedUsers = await this._resolveUsers(users, eventId);

    const args = cleanArgs({
      event_id: Number(eventId),
      status_id: opts.status,
      label: opts.label ?? undefined,
      description: opts.description ?? undefined,
      start: opts.start,
      end: opts.end,
      date: opts.date,
      duration: opts.duration,
      amount: opts.amount,
      currency: opts.currency,
      benefitable: opts.benefitable !== undefined ? parseBenefitable(opts.benefitable) : undefined,
      // 2807: settings (tags, reply_to, blocked_by, do_after) forwarded
      // verbatim. Backend ev 2796 c46 persists onto events.settings.
      settings: opts.settings,
      users: resolvedUsers.length > 0 ? resolvedUsers : undefined,
    });
    return this.call(TOOL_MAP.propose, args as Record<string, unknown>);
  }

  /** Status correction (optional) + progress comment in one shot.
   *
   * The event's own description is NOT touched. `desc` becomes the
   * body of a child comment-event, not a label/description overwrite
   * on the parent event. Use this for Hand/QA/Reviewer progress
   * reports — `propose --desc` would clobber the parent spec.
   */
  async progress(eventId: number, opts: ProgressOptions): Promise<ProgressResult> {
    let statusResult: unknown = null;
    if (opts.status !== undefined && opts.status !== null) {
      statusResult = await this.propose(eventId, { status: Number(opts.status) });
    }
    // Backend requires `label` on comment events — derive one from desc
    // (server-side validation rejects label-less comments).
    const label = deriveLabel(opts.desc);
    const commentResult = await this.comment(eventId, { label, description: opts.desc });
    return { status_correction: statusResult, comment: commentResult };
  }

  async vote(eventId: number, ids: number[], vote: boolean): Promise<unknown> {
    return this.call(TOOL_MAP.vote, {
      event_id: Number(eventId),
      ids: ids.map((i) => Number(i)),
      vote: Boolean(vote),
    });
  }

  /**
   * Resolve special markers ('creator', 'owner') in a users array to
   * actual user IDs before sending to the backend.
   *
   * 'creator' — fetched via task(eventId).user_id  (requires eventId)
   * 'owner'   — fetched via contract owner lookup    (requires contractId)
   *
   * When a marker cannot be resolved (missing context), an error is thrown.
   */
  private async _resolveUsers(
    users: ParticipantSpec[],
    eventId?: number,
    contractId?: number,
  ): Promise<ParticipantSpec[]> {
    const hasMarker = users.some((u) => u.type === 'creator' || u.type === 'owner');
    if (!hasMarker) return users;

    let creatorId: number | undefined;
    let ownerId: number | undefined;

    const resolved: ParticipantSpec[] = [];
    for (const u of users) {
      if (u.type === 'creator') {
        if (creatorId === undefined) {
          if (eventId === undefined) {
            throw new ContractError(
              'Cannot resolve "creator" marker without an event_id (not available in create context)',
            );
          }
          const event = (await this.task(eventId)) as Record<string, unknown>;
          creatorId = Number((event as Record<string, unknown>)['user_id']);
          if (!creatorId || Number.isNaN(creatorId)) {
            throw new ContractError(
              `Event ${eventId} has no user_id — cannot resolve "creator" marker`,
            );
          }
        }
        resolved.push({ participable_id: creatorId, type: 'user', role_id: u.role_id });
      } else if (u.type === 'owner') {
        if (ownerId === undefined) {
          const cid = contractId ?? await this._resolveOwnerContractId(eventId);
          ownerId = await this._resolveOwner(cid);
        }
        resolved.push({ participable_id: ownerId, type: 'user', role_id: u.role_id });
      } else {
        resolved.push(u);
      }
    }
    return resolved;
  }

  /**
   * Resolve "owner" marker to a contract's owner_id.
   * Fetches the contract list and filters by contract_id.
   */
  private async _resolveOwner(contractId: number): Promise<number> {
    const contracts = (await this.listContracts()) as
      | Array<Record<string, unknown>>
      | Record<string, unknown>;
    const list = Array.isArray(contracts)
      ? contracts
      : ((contracts as Record<string, unknown>)['contracts'] as Array<Record<string, unknown>>) ?? [];
    const contract = list.find((c) => Number(c['id']) === contractId);
    if (!contract) {
      throw new ContractError(`Contract ${contractId} not found — cannot resolve "owner" marker`);
    }
    let ownerId = Number(contract['owner_id']);
    if (!ownerId || Number.isNaN(ownerId)) {
      // Fallback: parse data.users for role_id:1 entry
      const contractData = contract['data'] as Record<string, unknown> | undefined;
      if (contractData?.users) {
        const users = contractData['users'] as Record<string, unknown>;
        for (const key of Object.keys(users)) {
          const entry = users[key] as Record<string, unknown>;
          if (Number(entry['role_id']) === 1) {
            const uid = Number(entry['user_id'] ?? entry['participable_id']);
            if (uid) {
              ownerId = uid;
              break;
            }
          }
        }
      }
    }
    if (!ownerId || Number.isNaN(ownerId)) {
      throw new ContractError(
        `Contract ${contractId} has no owner_id — cannot resolve "owner" marker`,
      );
    }
    return ownerId;
  }

  /**
   * Given an event_id, fetch the event to find its contract_id.
   * Used internally by _resolveUsers for the "owner" marker on propose.
   */
  private async _resolveOwnerContractId(eventId?: number): Promise<number> {
    if (eventId === undefined) {
      throw new ContractError('Cannot resolve "owner" marker without contract_id or event_id');
    }
    const event = (await this.task(eventId)) as Record<string, unknown>;
    const cid = Number(event['contract_id']);
    if (!cid || Number.isNaN(cid)) {
      throw new ContractError(
        `Event ${eventId} has no contract_id — cannot resolve "owner" marker`,
      );
    }
    return cid;
  }

  // ── polling (REST, not MCP) ────────────────────────────────────

  /** GET /agent/polling. Returns [] on 429 (rate-limit, 10/min/token). */
  async poll(): Promise<unknown[]> {
    const resp = await this.http.get(`${this.apiBase}/agent/polling`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
    });
    if (resp.status === 429) return [];
    if (resp.status !== 200) {
      let body: unknown;
      try {
        body = await resp.json();
      } catch {
        body = await resp.text();
      }
      throw new ContractError(`polling HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    const body = (await resp.json()) as unknown;
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      for (const k of ['notifications', 'data', 'items']) {
        const v = obj[k];
        if (Array.isArray(v)) return v;
      }
    }
    return [];
  }

  /**
   * Long-poll loop. Calls `poll()` every `seconds` (clamped to >= 6 — the
   * backend rate-limit is 10/min/token) and invokes `cb` with non-empty
   * batches. Runs until the caller aborts the process / kills the timer.
   */
  async watch(
    seconds: number,
    cb?: (notifications: unknown[]) => void | Promise<void>,
  ): Promise<void> {
    const interval = Math.max(6, Math.floor(seconds));
    for (;;) {
      const items = await this.poll();
      if (items.length > 0 && cb) await cb(items);
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  }
}
