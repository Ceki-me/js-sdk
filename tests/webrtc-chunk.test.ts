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

// ─────────────────────────────────────────────────────────────────────────────
// capture-chunk reassembly on the ceki-capture DC
// ─────────────────────────────────────────────────────────────────────────────

function makeCaptureTransport(): { transport: WebRTCTransport; channel: FakeChannel } {
  const transport = new WebRTCTransport();
  const channel = new FakeChannel();
  (transport as unknown as { _wireCaptureDc: (c: never) => void })._wireCaptureDc(
    channel as never,
  );
  return { transport, channel };
}

function captureChunkMessage(
  original: Record<string, unknown>,
  frameId: string,
  order: 'asc' | 'desc' = 'asc',
): string[] {
  const full = JSON.stringify(original);
  const total = Math.ceil(full.length / CHUNK_SIZE);
  const chunks: Record<string, unknown>[] = [];
  for (let i = 0; i < total; i++) {
    const chunk: Record<string, unknown> = {
      type: 'capture-chunk',
      frameId,
      seq: i,
      total,
      payload: full.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    };
    if (i === 0) {
      const meta: Record<string, unknown> = {};
      for (const key of ['type', 'timestamp', 'width', 'height', 'error']) {
        if (key in original) meta[key] = original[key];
      }
      chunk.meta = meta;
    }
    chunks.push(chunk);
  }
  return (order === 'desc' ? chunks.reverse() : chunks).map((c) => JSON.stringify(c));
}

describe('WebRTCTransport capture-chunk reassembly', () => {
  it('passes small (non-chunk) capture frames through unchanged', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    const frame = { type: 'video-frame', timestamp: 1234, data: 'tiny' };
    channel.emit('message', JSON.stringify(frame));

    expect(received).toEqual([frame]);
  });

  it('reassembles a chunked capture frame into the original frame', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    const original = { type: 'video-frame', timestamp: 7, data: 'x'.repeat(120_000) };
    for (const raw of captureChunkMessage(original, 'frame-test-1')) {
      channel.emit('message', raw);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(original);
  });

  it('reassembles capture chunks that arrive out of order', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    const original = { type: 'video-frame', timestamp: 9, data: 'y'.repeat(120_000) };
    for (const raw of captureChunkMessage(original, 'frame-oo', 'desc')) {
      channel.emit('message', raw);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(original);
  });

  it('does not forward an incomplete capture chunk set', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    const original = { type: 'video-frame', timestamp: 1, data: 'z'.repeat(120_000) };
    const full = JSON.stringify(original);
    const total = Math.ceil(full.length / CHUNK_SIZE);
    expect(total).toBeGreaterThan(1);

    // Send only the first two fragments of a multi-chunk frame
    for (let i = 0; i < Math.min(2, total - 1); i++) {
      channel.emit(
        'message',
        JSON.stringify({
          type: 'capture-chunk',
          frameId: 'frame-incomplete',
          seq: i,
          total,
          payload: full.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        }),
      );
    }

    expect(received).toEqual([]);
  });

  it('drops a malformed capture chunk without forwarding or buffering', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    channel.emit('message', JSON.stringify({ type: 'capture-chunk', seq: 0, total: 2 }));

    expect(received).toEqual([]);
  });

  it('prunes stale incomplete frames on the next chunk', () => {
    const { transport, channel } = makeCaptureTransport();
    const received: Record<string, unknown>[] = [];
    transport.onCaptureData = (msg) => {
      received.push(msg);
    };

    const original = { type: 'video-frame', timestamp: 1, data: 'w'.repeat(120_000) };
    const full = JSON.stringify(original);
    const total = Math.ceil(full.length / CHUNK_SIZE);

    // Buffer one incomplete frame
    channel.emit(
      'message',
      JSON.stringify({
        type: 'capture-chunk',
        frameId: 'frame-stale',
        seq: 0,
        total,
        payload: full.slice(0, CHUNK_SIZE),
      }),
    );

    const reassembler = (transport as unknown as { _captureReassembler: { frames: Map<string, unknown>; staleMs: number } })._captureReassembler;
    expect(reassembler.frames.size).toBe(1);

    // Force every buffered frame to look stale on the next handle call
    reassembler.staleMs = -1;

    // A chunk for a different frame triggers the prune pass
    channel.emit(
      'message',
      JSON.stringify({
        type: 'capture-chunk',
        frameId: 'frame-other',
        seq: 0,
        total,
        payload: full.slice(0, CHUNK_SIZE),
      }),
    );

    expect(reassembler.frames.has('frame-stale')).toBe(false);
    expect(reassembler.frames.has('frame-other')).toBe(true);
    expect(received).toEqual([]);
  });
});
