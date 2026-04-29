import { CekiBrowserError } from './errors.js';
import { Session } from './session.js';
import { Transport, DEFAULT_RELAY_URL } from './transport.js';
import type { BrowserOptions, SessionOptions } from './types.js';

export class Browser {
  private _transport: Transport;
  private _connected = false;

  constructor(options: BrowserOptions) {
    this._transport = new Transport(options.token, options.relayUrl ?? DEFAULT_RELAY_URL);
  }

  get agentId(): string | null {
    return this._transport.agentId;
  }

  get connected(): boolean {
    return this._connected && this._transport.connected;
  }

  onEvent(callback: (method: string, params: Record<string, unknown>) => void): void {
    this._transport.onEvent(callback);
  }

  async connect(): Promise<Record<string, unknown>> {
    const result = await this._transport.connect();
    this._connected = true;
    return result;
  }

  async close(): Promise<void> {
    this._connected = false;
    await this._transport.close();
  }

  async openSession(options: SessionOptions = {}): Promise<Session> {
    if (!this._connected) {
      throw new CekiBrowserError('Not connected. Call connect() first.');
    }

    const params: Record<string, unknown> = {
      mode: options.mode ?? 'incognito',
      max_price_per_min: options.maxPricePerMin ?? 1.0,
      estimated_duration_min: options.estimatedDurationMin ?? 30,
    };
    if (options.domainHints?.length) params.domain_hints = options.domainHints;
    if (options.geo) params.geo = options.geo;
    if (options.language) params.language = options.language;

    const session = new Session(this._transport, '', params.mode as string);
    session.installMatchListener();

    const result = (await this._transport.send('session.request', params, 30000)) as Record<string, unknown>;
    session.requestId = (result?.request_id ?? '') as string;

    await session.waitForActive(options.waitTimeout ?? 60000);
    return session;
  }
}
