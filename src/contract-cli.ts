// CLI handlers for `ceki contract …` and `ceki timelog …` subcommands.

import {
  ContractClient,
  ContractError,
  ROLE_QA,
  ROLE_REVIEWER,
  contractIdsFromEnv,
  type ParticipantSpec,
  type TagSpec,
  type ContractSettings,
} from './contract.js';
import { TimelogClient } from './timelog.js';

function out(data: unknown): void {
  if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

function err(message: string, code = 'error'): void {
  process.stderr.write(JSON.stringify({ error: message, code }) + '\n');
}

/** Parse 'agent:5:reviewer' / 'user:7:qa' / 'agent:5:role:42'. */
export function parseParticipantSpec(spec: string): ParticipantSpec {
  if (!spec || typeof spec !== 'string') {
    throw new Error(`--participant must be a non-empty string, got: ${JSON.stringify(spec)}`);
  }
  const parts = spec.split(':');
  if (parts.length < 3) {
    throw new Error(
      `--participant must be 'type:id:role' (e.g. agent:5:reviewer), got: ${JSON.stringify(spec)}`,
    );
  }
  const [ptype, pid, role, ...rest] = parts;
  if (ptype !== 'agent' && ptype !== 'user') {
    throw new Error(`--participant type must be 'agent' or 'user', got: ${JSON.stringify(ptype)}`);
  }
  const value = Number.parseInt(pid, 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`--participant id must be int, got: ${JSON.stringify(pid)}`);
  }
  const roleMap: Record<string, number> = { reviewer: ROLE_REVIEWER, qa: ROLE_QA };
  let roleId: number;
  if (role in roleMap) {
    roleId = roleMap[role];
  } else if (role === 'role') {
    if (rest.length === 0) {
      throw new Error(`--participant 'role:NUMBER' needs a number, got: ${JSON.stringify(spec)}`);
    }
    const n = Number.parseInt(rest[0], 10);
    if (!Number.isFinite(n) || Number.isNaN(n)) {
      throw new Error(`--participant role id must be int, got: ${JSON.stringify(rest[0])}`);
    }
    roleId = n;
  } else {
    throw new Error(
      `--participant unknown role ${JSON.stringify(role)}; expected 'reviewer', 'qa', or 'role:NUMBER'`,
    );
  }
  return { participable_id: value, type: ptype, role_id: roleId };
}

/**
 * Parse the `--tags` sugar into settings.tags[] elements. Comma-separated;
 * each item is `key[:label[:color]]`:
 *   backend,urgent           -> [{key:backend},{key:urgent}]
 *   backend:Backend:#ff0000  -> [{key:backend,label:Backend,color:#ff0000}]
 *   docs::#0af               -> [{key:docs,color:#0af}]   (empty label skipped)
 */
export function parseTagsSpec(spec: string): TagSpec[] {
  const tags: TagSpec[] = [];
  for (const raw of spec.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    const key = (idx === -1 ? item : item.slice(0, idx)).trim();
    if (!key) throw new Error(`--tags item needs a key, got: ${JSON.stringify(raw)}`);
    const tag: TagSpec = { key };
    if (idx !== -1) {
      const tail = item.slice(idx + 1);
      const ci = tail.indexOf(':');
      const label = (ci === -1 ? tail : tail.slice(0, ci)).trim();
      const color = ci === -1 ? '' : tail.slice(ci + 1).trim();
      if (label) tag.label = label;
      if (color) tag.color = color;
    }
    tags.push(tag);
  }
  if (tags.length === 0) throw new Error(`--tags produced no tags from: ${JSON.stringify(spec)}`);
  return tags;
}

// ── tiny argv parser (no commander) — matches python argparse semantics ──

type Args = {
  positional: string[];
  flags: Record<string, string | string[] | true>;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        // repeatable: collect into array
        if (flags[name] !== undefined) {
          const cur = flags[name];
          if (Array.isArray(cur)) cur.push(next);
          else flags[name] = [cur as string, next];
        } else {
          flags[name] = next;
        }
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  if (v === undefined || v === true) return undefined;
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

function flagInt(args: Args, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`--${key} must be int, got: ${JSON.stringify(v)}`);
  return n;
}

function flagList(args: Args, key: string): string[] {
  const v = args.flags[key];
  if (v === undefined) return [];
  if (v === true) return [];
  if (Array.isArray(v)) return v;
  return [v as string];
}

function requireFlag(args: Args, key: string): string {
  const v = flagStr(args, key);
  if (v === undefined) throw new Error(`--${key} is required`);
  return v;
}

/**
 * Resolve TASK_REVIEWER env value to a reviewer spec string.
 *
 * Supports:
 *   - `agent:N` / `user:N` → passed through as-is
 *   - `creator` → resolved via `client.listContracts()`, extracting the
 *     contract's creator as `type:id`
 *   - `owner` → same but extracts the contract's owner
 *   - any other value → passed through as-is
 */
async function resolveTaskReviewer(
  client: ContractClient,
  cid: number,
  raw: string,
): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('TASK_REVIEWER is empty');

  if (trimmed.startsWith('agent:') || trimmed.startsWith('user:')) {
    return trimmed;
  }

  if (trimmed !== 'creator' && trimmed !== 'owner') {
    return trimmed; // pass through unknown value
  }

  // Resolve creator/owner from the contract list
  const rawResult = await client.listContracts();
  let contracts: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawResult)) {
    contracts = rawResult;
  } else if (rawResult && typeof rawResult === 'object') {
    const items = (rawResult as Record<string, unknown>).items;
    if (Array.isArray(items)) contracts = items;
  }

  const contract = contracts.find((c) => Number(c.id) === cid);
  if (!contract) {
    throw new Error(
      `TASK_REVIEWER=${trimmed}: contract ${cid} not found in your contract list`,
    );
  }

  // Try nested object: contract.creator / contract.owner
  const nest = contract[trimmed];
  if (nest && typeof nest === 'object' && !Array.isArray(nest)) {
    const o = nest as Record<string, unknown>;
    const id = o.id ?? o.user_id;
    const ptype = (o.type as string | undefined) ?? (o.participable_type as string | undefined) ?? 'user';
    if (id != null) return `${ptype}:${String(id)}`;
  }

  // Fallback to flat fields: creator_id, creator_type / owner_id, owner_type
  const idKey = `${trimmed}_id`;
  const typeKey = `${trimmed}_type`;
  const flatId = (contract as Record<string, unknown>)[idKey];
  if (flatId != null) {
    const flatType = ((contract as Record<string, unknown>)[typeKey] as string | undefined) ?? 'user';
    return `${flatType}:${String(flatId)}`;
  }

  throw new Error(
    `TASK_REVIEWER=${trimmed}: cannot resolve ${trimmed} for contract ${cid}`,
  );
}

function dump(value: unknown): void {
  out(value);
}

// ── contract subcommand dispatcher ──────────────────────────────────────

/** Factory hook so tests can inject a fake ContractClient. */
let contractClientFactory: () => ContractClient = () => new ContractClient();

export function _setContractClientFactory(f: () => ContractClient): void {
  contractClientFactory = f;
}
export function _resetContractClientFactory(): void {
  contractClientFactory = () => new ContractClient();
}

let timelogClientFactory: () => TimelogClient = () => new TimelogClient();

export function _setTimelogClientFactory(f: () => TimelogClient): void {
  timelogClientFactory = f;
}
export function _resetTimelogClientFactory(): void {
  timelogClientFactory = () => new TimelogClient();
}

export async function cmdContract(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) {
    err('contract: subcommand required', 'args');
    return 1;
  }
  const rest = argv.slice(1);
  const args = parseArgs(rest);
  const client = contractClientFactory();

  try {
    switch (action) {
      case 'list': {
        dump(await client.listContracts());
        return 0;
      }
      case 'members': {
        const cid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(cid)) {
          err('contract members: cid required', 'args');
          return 1;
        }
        dump(await client.members(cid));
        return 0;
      }
      case 'tasks': {
        const explicit = args.positional[0];
        const ids =
          explicit !== undefined ? [explicit] : contractIdsFromEnv();
        if (ids.length === 0) {
          err('no contract id (positional or CEKI_CONTRACT_IDS)', 'args');
          return 1;
        }
        for (const cid of ids) {
          process.stdout.write(`--- contract ${cid} ---\n`);
          dump(await client.tasks(Number(cid)));
        }
        return 0;
      }
      case 'my-events': {
        dump(await client.myEvents());
        return 0;
      }
      case 'my-jobs': {
        process.stderr.write('⚠️  [DEPRECATED] use `ceki hire my-jobs` instead\n');
        dump(await client.myJobs());
        return 0;
      }
      case 'call-human': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract call-human: event_id required', 'args');
          return 1;
        }
        const kind = flagStr(args, 'kind');
        if (kind === undefined) {
          err('contract call-human: --kind is required', 'args');
          return 1;
        }
        if (!['input', 'review', 'stuck'].includes(kind)) {
          err(
            `contract call-human: --kind must be 'input' | 'review' | 'stuck', got ${JSON.stringify(kind)}`,
            'args',
          );
          return 1;
        }
        const desc = flagStr(args, 'desc');
        if (desc === undefined) {
          err('contract call-human: --desc is required', 'args');
          return 1;
        }
        dump(
          await client.callHuman(eid, kind as 'input' | 'review' | 'stuck', desc),
        );
        return 0;
      }
      case 'task': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract task: eid required', 'args');
          return 1;
        }
        dump(await client.task(eid));
        return 0;
      }
      case 'children': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract children: eid required', 'args');
          return 1;
        }
        dump(await client.children(eid));
        return 0;
      }
      case 'history': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract history: eid required', 'args');
          return 1;
        }
        dump(await client.history(eid, { limit: flagInt(args, 'limit') }));
        return 0;
      }
      case 'create': {
        const explicit = args.positional[0];
        let cid: number;
        if (explicit !== undefined) {
          cid = Number.parseInt(explicit, 10);
        } else {
          const envIds = contractIdsFromEnv();
          if (envIds.length === 0) {
            err('contract id required (positional or CEKI_CONTRACT_IDS)', 'args');
            return 1;
          }
          cid = Number.parseInt(envIds[0], 10);
        }
        if (Number.isNaN(cid)) {
          err('contract create: cid must be int', 'args');
          return 1;
        }

        // CLI-args > env (TASK_*) > current default (undefined = API default)
        // --qa
        let qa = flagStr(args, 'qa');
        if (qa === undefined) {
          const envQa = process.env.TASK_QA;
          if (envQa && envQa.trim()) qa = envQa.trim();
        }

        // --reviewer (with creator/owner keyword resolution)
        let reviewer = flagStr(args, 'reviewer');
        if (reviewer === undefined) {
          const envReviewer = process.env.TASK_REVIEWER;
          if (envReviewer && envReviewer.trim()) {
            try {
              reviewer = await resolveTaskReviewer(client, cid, envReviewer.trim());
            } catch (e) {
              err((e as Error).message, 'config');
              return 1;
            }
          }
        }

        // --status
        let status = flagInt(args, 'status');
        if (status === undefined) {
          const envStatus = process.env.TASK_DEFAULT_STATUS;
          if (envStatus && envStatus.trim()) {
            const parsed = Number.parseInt(envStatus.trim(), 10);
            if (!Number.isNaN(parsed)) status = parsed;
          }
        }

        const label = requireFlag(args, 'label');
        const dataRaw = flagStr(args, 'data');
        const dataObj = dataRaw ? JSON.parse(dataRaw) : undefined;
        let extras: ParticipantSpec[] = [];
        let tags: TagSpec[] | undefined;
        try {
          extras = flagList(args, 'participant').map(parseParticipantSpec);
          const tagsRaw = flagStr(args, 'tags');
          if (tagsRaw) tags = parseTagsSpec(tagsRaw);
        } catch (e) {
          err((e as Error).message, 'args');
          return 1;
        }
        dump(
          await client.create(cid, {
            label,
            type: flagInt(args, 'type'),
            status,
            kalScheduleId: flagInt(args, 'kal-schedule'),
            start: flagStr(args, 'start'),
            end: flagStr(args, 'end'),
            timezone: flagStr(args, 'timezone'),
            date: flagStr(args, 'date'),
            duration: flagInt(args, 'duration'),
            amount: flagInt(args, 'amount'),
            currency: flagStr(args, 'currency'),
            description: flagStr(args, 'desc'),
            data: dataObj,
            benefitable: flagStr(args, 'benefitable'),
            reviewer,
            qa,
            participants: extras.length > 0 ? extras : undefined,
            tags,
          }),
        );
        return 0;
      }
      case 'comment': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract comment: eid required', 'args');
          return 1;
        }
        dump(
          await client.comment(eid, {
            label: flagStr(args, 'label'),
            type: flagInt(args, 'type'),
            status: flagInt(args, 'status'),
            start: flagStr(args, 'start'),
            end: flagStr(args, 'end'),
            date: flagStr(args, 'date'),
            duration: flagInt(args, 'duration'),
            amount: flagInt(args, 'amount'),
            currency: flagStr(args, 'currency'),
            description: flagStr(args, 'desc'),
            benefitable: flagStr(args, 'benefitable'),
          }),
        );
        return 0;
      }
      case 'propose': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract propose: eid required', 'args');
          return 1;
        }
        // 2807: --tags <key[:label[:color]]> (repeatable, also
        // comma-separated within each flag) → settings.tags[] on the wire.
        const tagsEntries = flagList(args, 'tags');
        let settings: ContractSettings | undefined;
        if (tagsEntries.length > 0) {
          try {
            const tags = parseTagsSpec(tagsEntries.join(','));
            settings = { tags };
          } catch (e) {
            err((e as Error).message, 'args');
            return 1;
          }
        }
        // Parse participant/reviewer/qa — same logic as create()
        let extras: ParticipantSpec[] = [];
        try {
          extras = flagList(args, 'participant').map(parseParticipantSpec);
        } catch (e) {
          err((e as Error).message, 'args');
          return 1;
        }
        dump(
          await client.propose(eid, {
            status: flagInt(args, 'status'),
            label: flagStr(args, 'label'),
            description: flagStr(args, 'desc'),
            start: flagStr(args, 'start'),
            end: flagStr(args, 'end'),
            date: flagStr(args, 'date'),
            duration: flagInt(args, 'duration'),
            amount: flagInt(args, 'amount'),
            currency: flagStr(args, 'currency'),
            benefitable: flagStr(args, 'benefitable'),
            reviewer: flagStr(args, 'reviewer'),
            qa: flagStr(args, 'qa'),
            participants: extras.length > 0 ? extras : undefined,
            settings,
          }),
        );
        return 0;
      }
      case 'progress': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract progress: eid required', 'args');
          return 1;
        }
        const desc = flagStr(args, 'desc');
        if (desc === undefined) {
          err('contract progress: --desc is required', 'args');
          return 1;
        }
        dump(
          await client.progress(eid, {
            status: flagInt(args, 'status'),
            desc,
          }),
        );
        return 0;
      }
      case 'vote': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('contract vote: eid required', 'args');
          return 1;
        }
        const idsRaw = requireFlag(args, 'ids');
        const voteRaw = requireFlag(args, 'vote');
        const ids = idsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number.parseInt(s, 10));
        const vote = ['true', '1', 'yes'].includes(voteRaw.toLowerCase());
        dump(await client.vote(eid, ids, vote));
        return 0;
      }
      case 'poll': {
        const items = await client.poll();
        dump({ count: items.length, notifications: items });
        return 0;
      }
      case 'watch': {
        const interval = Math.max(6, Number.parseInt(args.positional[0] ?? '8', 10) || 8);
        process.stderr.write(
          `[watch] poll every ${interval}s (limit 10/min/token; do not go below 6s)\n`,
        );
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const items = await client.poll();
          if (items.length > 0) {
            const ts = new Date().toISOString();
            for (const n of items) {
              process.stdout.write(JSON.stringify({ ts, notification: n }) + '\n');
            }
          }
          await new Promise((r) => setTimeout(r, interval * 1000));
        }
      }
      case 'tools': {
        dump(await client.tools());
        return 0;
      }
      case 'raw': {
        const tool = args.positional[0];
        if (!tool) {
          err('contract raw: tool name required', 'args');
          return 1;
        }
        const payloadRaw = args.positional[1] ?? '{}';
        const payload = JSON.parse(payloadRaw);
        dump(await client.raw(tool, payload));
        return 0;
      }
      default: {
        err(`unknown contract action: ${action}`, 'args');
        return 1;
      }
    }
  } catch (e) {
    if (e instanceof ContractError) {
      err(e.message, 'contract');
      return 1;
    }
    err((e as Error).message ?? String(e), 'error');
    return 1;
  }
}

export async function cmdTimelog(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) {
    err('timelog: subcommand required', 'args');
    return 1;
  }
  const rest = argv.slice(1);
  const args = parseArgs(rest);
  const client = timelogClientFactory();
  try {
    switch (action) {
      case 'start': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('timelog start: event_id required', 'args');
          return 1;
        }
        dump(await client.start(eid));
        return 0;
      }
      case 'stop': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('timelog stop: event_id required', 'args');
          return 1;
        }
        dump(await client.stop(eid, flagStr(args, 'label')));
        return 0;
      }
      case 'check': {
        const eid = Number.parseInt(args.positional[0] ?? '', 10);
        if (Number.isNaN(eid)) {
          err('timelog check: event_id required', 'args');
          return 1;
        }
        dump(await client.check(eid));
        return 0;
      }
      default: {
        err(`unknown timelog action: ${action}`, 'args');
        return 1;
      }
    }
  } catch (e) {
    if (e instanceof ContractError) {
      err(e.message, 'timelog');
      return 1;
    }
    err((e as Error).message ?? String(e), 'error');
    return 1;
  }
}

export async function cmdHire(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action) {
    err('hire: subcommand required', 'args');
    return 1;
  }
  const rest = argv.slice(1);
  const args = parseArgs(rest);
  const client = contractClientFactory();

  try {
    switch (action) {
      case 'my-jobs': {
        dump(await client.myJobs());
        return 0;
      }
      default: {
        err(`unknown hire action: ${action}`, 'args');
        return 1;
      }
    }
  } catch (e) {
    if (e instanceof ContractError) {
      err(e.message, 'contract');
      return 1;
    }
    err((e as Error).message ?? String(e), 'error');
    return 1;
  }
}
