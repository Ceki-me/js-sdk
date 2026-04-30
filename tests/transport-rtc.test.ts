import { describe, it, expect, vi } from 'vitest';
import { CekiBrowserError, CommandTimeout } from '../src/errors.js';

let onMessageHandler: ((ev: { data: string }) => void) | null = null;

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

const { RTCTransport } = await import('../src/transport-rtc.js');

function makeTransport() {
  const transport = new RTCTransport([{ urls: 'stun:stun.l.google.com:19302' }]);
  const cmdCh = (transport as unknown as { pc: MockPeerConnection }).pc._channels
    .find((c) => c.label === 'ceki-cmd')!;
  return { transport, cmdCh };
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
