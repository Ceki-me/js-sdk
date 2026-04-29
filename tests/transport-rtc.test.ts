import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CekiBrowserError, CommandTimeout } from '../src/errors.js';

let onMessageHandler: ((ev: { data: string }) => void) | null = null;
let chatOnMessageHandler: ((ev: { data: string }) => void) | null = null;

class MockDataChannel {
  label: string;
  readyState = 'open';
  ordered = true;
  _sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  send(data: string) {
    this._sent.push(data);
  }

  emit(data: string) {
    this.onmessage?.({ data });
  }
}

class MockPeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  _channels: MockDataChannel[] = [];

  createDataChannel(label: string) {
    const ch = new MockDataChannel(label);
    this._channels.push(ch);
    if (label === 'ceki-cmd') {
      setTimeout(() => { onMessageHandler = ch.onmessage; }, 0);
    } else if (label === 'ceki-chat') {
      setTimeout(() => { chatOnMessageHandler = ch.onmessage; }, 0);
    }
    return ch;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'mock-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
  }

  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

vi.stubGlobal('RTCPeerConnection', MockPeerConnection);
vi.stubGlobal('RTCSessionDescription', class {
  constructor(public init: RTCSessionDescriptionInit) {}
});
vi.stubGlobal('RTCIceCandidate', class {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? '';
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
});

const { RTCTransport, CHUNK_SIZE } = await import('../src/transport-rtc.js');

function makeTransport() {
  const transport = new RTCTransport([{ urls: 'stun:stun.l.google.com:19302' }]);
  const cmdCh = (transport as unknown as { pc: MockPeerConnection }).pc._channels
    .find((c) => c.label === 'ceki-cmd')!;
  const chatCh = (transport as unknown as { pc: MockPeerConnection }).pc._channels
    .find((c) => c.label === 'ceki-chat')!;
  return { transport, cmdCh, chatCh };
}

describe('RTCTransport', () => {
  it('sendCommand roundtrip via ceki-cmd DataChannel', async () => {
    const { transport, cmdCh } = makeTransport();

    const promise = transport.sendCommand('browser.navigate', { url: 'https://example.com' }, 2000);

    await vi.waitFor(() => expect(cmdCh._sent.length).toBeGreaterThan(0));
    const sent = JSON.parse(cmdCh._sent[0]);
    expect(sent.method).toBe('browser.navigate');
    expect(sent.params.url).toBe('https://example.com');

    cmdCh.emit(JSON.stringify({
      jsonrpc: '2.0',
      result: { url: 'https://example.com', title: 'Example', status: 200 },
      id: sent.id,
    }));

    const result = await promise;
    expect((result as Record<string, unknown>).url).toBe('https://example.com');
    transport.close();
  });

  it('sendCommand error response', async () => {
    const { transport, cmdCh } = makeTransport();

    const promise = transport.sendCommand('browser.screenshot', undefined, 2000);

    await vi.waitFor(() => expect(cmdCh._sent.length).toBeGreaterThan(0));
    const sent = JSON.parse(cmdCh._sent[0]);

    cmdCh.emit(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -1010, message: 'Provider disconnected' },
      id: sent.id,
    }));

    await expect(promise).rejects.toThrow(CekiBrowserError);
    await expect(promise).rejects.toThrow('Provider disconnected');
    transport.close();
  });

  it('sendCommand timeout', async () => {
    const { transport } = makeTransport();

    vi.useFakeTimers();
    const promise = transport.sendCommand('browser.navigate', undefined, 100);
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    await expect(promise).rejects.toThrow(CommandTimeout);
    transport.close();
  });

  it('sendChatText sends via ceki-chat DataChannel', () => {
    const { transport, chatCh } = makeTransport();

    transport.sendChatText('hello from agent');

    expect(chatCh._sent).toHaveLength(1);
    const sent = JSON.parse(chatCh._sent[0]);
    expect(sent.type).toBe('msg');
    expect(sent.text).toBe('hello from agent');
    expect(sent.from).toBe('agent');
    expect(transport.chatHistory).toHaveLength(1);
    transport.close();
  });

  it('receives chat text message and dispatches to handlers', () => {
    const { transport, chatCh } = makeTransport();

    const received: Array<{ text: string; from: string }> = [];
    transport.onChatMessage((msg) => received.push({ text: msg.text, from: msg.from }));

    chatCh.emit(JSON.stringify({
      type: 'msg',
      id: 'msg-1',
      from: 'provider',
      ts: Date.now(),
      text: 'hello from provider',
    }));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hello from provider');
    expect(received[0].from).toBe('provider');
    expect(transport.chatHistory).toHaveLength(1);
    transport.close();
  });

  it('receives chunked image and assembles', () => {
    const { transport, chatCh } = makeTransport();

    const receivedImages: Array<{ id: string; mime: string }> = [];
    transport.onChatImage((img) => receivedImages.push({ id: img.id, mime: img.mime }));

    const raw = new Uint8Array(1024);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 256;
    const b64 = Buffer.from(raw).toString('base64');
    const totalChunks = Math.ceil(b64.length / (12 * 1024));

    chatCh.emit(JSON.stringify({
      type: 'img-start',
      id: 'img-1',
      from: 'provider',
      ts: 1000,
      mime: 'image/png',
      size_bytes: raw.length,
      total_chunks: totalChunks,
    }));

    for (let i = 0; i < totalChunks; i++) {
      chatCh.emit(JSON.stringify({
        type: 'img-chunk',
        id: 'img-1',
        seq: i,
        data: b64.slice(i * 12 * 1024, (i + 1) * 12 * 1024),
      }));
    }

    chatCh.emit(JSON.stringify({ type: 'img-end', id: 'img-1' }));

    expect(receivedImages).toHaveLength(1);
    expect(receivedImages[0].id).toBe('img-1');
    expect(receivedImages[0].mime).toBe('image/png');
    transport.close();
  });

  it('sendChatImage rejects oversized images', async () => {
    const { transport } = makeTransport();

    const huge = new Uint8Array(6 * 1024 * 1024);
    await expect(transport.sendChatImage(huge)).rejects.toThrow(/too large/i);
    transport.close();
  });

  it('assembler timeout cleans up incomplete image', () => {
    const { transport, chatCh } = makeTransport();

    chatCh.emit(JSON.stringify({
      type: 'img-start',
      id: 'img-timeout',
      from: 'provider',
      ts: 1000,
      mime: 'image/png',
      size_bytes: 1000,
      total_chunks: 5,
    }));

    const assemblers = (transport as unknown as { _assemblers: Map<string, unknown> })._assemblers;
    expect(assemblers.has('img-timeout')).toBe(true);

    (transport as unknown as { _assemblerTimeout: (id: string) => void })._assemblerTimeout('img-timeout');

    expect(assemblers.has('img-timeout')).toBe(false);
    transport.close();
  });

  it('close clears history and pending commands', () => {
    const { transport } = makeTransport();

    transport.sendChatText('msg1');
    transport.sendChatText('msg2');
    expect(transport.chatHistory).toHaveLength(2);

    transport.close();
    expect(transport.chatHistory).toHaveLength(0);
  });

  it('createOffer returns SDP', async () => {
    const { transport } = makeTransport();
    const offer = await transport.createOffer();
    expect(offer.type).toBe('offer');
    transport.close();
  });

  it('onSignaling callback receives ICE candidates', () => {
    const { transport } = makeTransport();
    const signals: Array<{ method: string; params: Record<string, unknown> }> = [];
    transport.onSignaling((method, params) => signals.push({ method, params }));

    const pc = (transport as unknown as { pc: MockPeerConnection }).pc;
    pc.onicecandidate?.({
      candidate: {
        candidate: 'candidate:1234',
        sdpMid: '0',
        sdpMLineIndex: 0,
      } as RTCIceCandidate,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0].method).toBe('webrtc.ice');
    expect(signals[0].params.candidate).toBe('candidate:1234');
    transport.close();
  });
});
