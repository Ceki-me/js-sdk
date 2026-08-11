import { describe, it, expect } from 'vitest';
import { WebRTCTransport } from '../src/webrtc.js';

type Listener = (event: { data: string }) => void;

class FakeChannel {
  private listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data });
  }
}

const CHUNK_SIZE = 48000; // mirror the extension's chunking constant

function makeTransport(): { transport: WebRTCTransport; channel: FakeChannel } {
  const transport = new WebRTCTransport();
  const channel = new FakeChannel();
  (transport as unknown as { _wireCmdDc: (c: never) => void })._wireCmdDc(
    channel as never,
  );
  return { transport, channel };
}

function chunkMessage(
  original: Record<string, unknown>,
  chunkId: string,
  order: 'asc' | 'desc' = 'asc',
): string[] {
  const full = JSON.stringify(original);
  const total = Math.ceil(full.length / CHUNK_SIZE);
  const chunks: Record<string, unknown>[] = [];
  for (let i = 0; i < total; i++) {
    const chunk: Record<string, unknown> = {
      type: 'cdp-response-chunk',
      chunkId,
      seq: i,
      total,
      payload: full.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    };
    if (i === 0) {
      chunk.meta = { id: original.id };
    }
    chunks.push(chunk);
  }
  return (order === 'desc' ? chunks.reverse() : chunks).map((c) => JSON.stringify(c));
}

describe('WebRTCTransport chunk reassembly', () => {
  it('passes small (non-chunk) messages through unchanged', () => {
    const { transport, channel } = makeTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCdpMessage = (msg) => {
      received.push(msg);
    };

    const msg = { type: 'cdp_response', id: 1, result: { ok: true } };
    channel.emit('message', JSON.stringify(msg));

    expect(received).toEqual([msg]);
  });

  it('reassembles a chunked message into the original payload', () => {
    const { transport, channel } = makeTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCdpMessage = (msg) => {
      received.push(msg);
    };

    const original = { type: 'cdp_response', id: 99, result: { data: 'x'.repeat(120_000) } };
    for (const raw of chunkMessage(original, 'chunk-test-1')) {
      channel.emit('message', raw);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(original);
  });

  it('reassembles chunks that arrive out of order', () => {
    const { transport, channel } = makeTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCdpMessage = (msg) => {
      received.push(msg);
    };

    const original = { type: 'cdp_response', id: 55, result: { data: 'y'.repeat(120_000) } };
    for (const raw of chunkMessage(original, 'chunk-oo', 'desc')) {
      channel.emit('message', raw);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(original);
  });

  it('does not forward an incomplete chunk set', () => {
    const { transport, channel } = makeTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCdpMessage = (msg) => {
      received.push(msg);
    };

    const original = { id: 1, result: { data: 'z'.repeat(120_000) } };
    const full = JSON.stringify(original);
    const total = Math.ceil(full.length / CHUNK_SIZE);
    expect(total).toBeGreaterThan(1);

    // Send only the first two fragments
    for (let i = 0; i < Math.min(2, total - 1); i++) {
      channel.emit(
        'message',
        JSON.stringify({
          type: 'cdp-response-chunk',
          chunkId: 'incomplete',
          seq: i,
          total,
          payload: full.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        }),
      );
    }

    expect(received).toEqual([]);
  });

  it('drops a malformed chunk without forwarding or buffering', () => {
    const { transport, channel } = makeTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCdpMessage = (msg) => {
      received.push(msg);
    };

    channel.emit('message', JSON.stringify({ type: 'cdp-response-chunk', seq: 0, total: 2 }));

    expect(received).toEqual([]);
  });
});
