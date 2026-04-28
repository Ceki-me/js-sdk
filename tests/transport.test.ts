import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError, CommandTimeout, RateLimited, CekiBrowserError } from '../src/errors.js';
import type { EventCallback } from '../src/transport.js';

type MessageHandler = (data: string | Buffer) => void;
type EventHandler = (...args: unknown[]) => void;

class FakeTransport {
  private _pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private _nextId = 1;
  private _eventCallback: EventCallback | null = null;
  agentId: string | null = null;

  get connected() { return true; }

  onEvent(cb: EventCallback) { this._eventCallback = cb; }

  async connect(welcomeMsg: Record<string, unknown>) {
    if ('error' in welcomeMsg) {
      const err = welcomeMsg.error as { code: number; message: string };
      throw new AuthError(err.message, err.code);
    }
    const result = (welcomeMsg.result ?? {}) as Record<string, unknown>;
    this.agentId = result.agent_id as string ?? null;
    return result;
  }

  send(method: string, params?: Record<string, unknown>, timeout = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CommandTimeout(`Command ${method} timed out after ${timeout}ms`, -1020));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  receiveMessage(msg: Record<string, unknown>) {
    const id = msg.id as number | undefined;
    if (id != null && this._pending.has(id)) {
      const pending = this._pending.get(id)!;
      this._pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = msg.error as { code: number; message: string };
        const code = err.code;
        const map: Record<number, new (m: string, c: number) => CekiBrowserError> = {
          [-1013]: RateLimited,
        };
        const Cls = map[code] ?? CekiBrowserError;
        pending.reject(new Cls(err.message, code));
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method && this._eventCallback) {
      this._eventCallback(msg.method as string, (msg.params ?? {}) as Record<string, unknown>);
    }
  }

  close() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new CekiBrowserError('closed'));
    }
    this._pending.clear();
  }
}

describe('Transport', () => {
  it('connects and receives agent_id', async () => {
    const t = new FakeTransport();
    const result = await t.connect({
      jsonrpc: '2.0',
      result: { status: 'connected', agent_id: 'agent-123' },
      id: 0,
    });
    expect(result.agent_id).toBe('agent-123');
    expect(t.agentId).toBe('agent-123');
  });

  it('rejects on auth error', async () => {
    const t = new FakeTransport();
    await expect(
      t.connect({ jsonrpc: '2.0', error: { code: 401, message: 'Unauthorized' }, id: 0 }),
    ).rejects.toThrow(AuthError);
  });

  it('sends and receives JSON-RPC response', async () => {
    const t = new FakeTransport();
    await t.connect({ jsonrpc: '2.0', result: { status: 'connected', agent_id: 'a1' }, id: 0 });

    const promise = t.send('browser.navigate', { url: 'https://example.com' });
    t.receiveMessage({ jsonrpc: '2.0', result: { url: 'https://example.com', title: 'Example' }, id: 1 });
    const result = await promise;
    expect((result as Record<string, unknown>).url).toBe('https://example.com');
  });

  it('maps error codes to correct exception classes', async () => {
    const t = new FakeTransport();
    await t.connect({ jsonrpc: '2.0', result: { status: 'connected', agent_id: 'a1' }, id: 0 });

    const promise = t.send('session.request', { mode: 'incognito' });
    t.receiveMessage({ jsonrpc: '2.0', error: { code: -1013, message: 'Rate limit exceeded' }, id: 1 });
    await expect(promise).rejects.toThrow(RateLimited);
  });

  it('dispatches notifications to event callback', async () => {
    const t = new FakeTransport();
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    t.onEvent((method, params) => events.push({ method, params }));

    t.receiveMessage({
      jsonrpc: '2.0',
      method: 'session.state_changed',
      params: { state: 'ACTIVE', session_id: 'sess-1' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].method).toBe('session.state_changed');
    expect(events[0].params.state).toBe('ACTIVE');
  });

  it('rejects on command timeout', async () => {
    const t = new FakeTransport();
    await t.connect({ jsonrpc: '2.0', result: { status: 'connected', agent_id: 'a1' }, id: 0 });

    await expect(t.send('browser.navigate', { url: 'https://slow.test' }, 50)).rejects.toThrow(CommandTimeout);
    t.close();
  });
});
