// Client for /mcp/agent timelog tools (start/stop/check by event_id).
// Thin wrapper around ContractClient — same transport, same auth, same env.

import { ContractClient, ContractError, type ContractClientOptions } from './contract.js';

const TOOL_MAP = {
  start: 'timelog-start',
  stop: 'timelog-stop',
  check: 'timelog-check',
} as const;

export type TimelogClientOptions = ContractClientOptions & {
  contract?: ContractClient;
};

export class TimelogClient {
  private c: ContractClient;

  constructor(opts: TimelogClientOptions = {}) {
    if (opts.contract) {
      this.c = opts.contract;
    } else {
      this.c = new ContractClient(opts);
    }
  }

  async start(eventId: number): Promise<unknown> {
    return this.c.call(TOOL_MAP.start, { event_id: Number(eventId) });
  }

  async stop(eventId: number, label?: string): Promise<unknown> {
    const args: Record<string, unknown> = { event_id: Number(eventId) };
    if (label !== undefined && label !== null) args['label'] = label;
    return this.c.call(TOOL_MAP.stop, args);
  }

  async check(eventId: number): Promise<unknown> {
    return this.c.call(TOOL_MAP.check, { event_id: Number(eventId) });
  }
}

export { ContractError };
