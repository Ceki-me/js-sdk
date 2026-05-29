import { EventEmitter } from 'events';
import type { Match } from '../src/types.js';

export class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  readyState = 1; // OPEN
  sent: Record<string, unknown>[] = [];
  url: string;
  protocols?: string[];

  static OPEN = 1;
  static CLOSED = 3;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    MockWebSocket.instances.push(this);
    // Auto-fire 'open' in next tick
    setTimeout(() => this.emit('open'), 0);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  removeAllListeners() {
    super.removeAllListeners();
    return this;
  }

  /** Simulate receiving a message from server */
  receive(msg: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

export function makeMatch(overrides?: Partial<Match>): Match {
  return {
    session_id: 'sess-test-123',
    schedule_id: 42,
    event_id: 'evt-1',
    chat_topic_id: 'topic-1',
    provider_user_id: 7,
    started_at: Date.now(),
    browser_info: { userAgent: 'test' },
    ...overrides,
  };
}
