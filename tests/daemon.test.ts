import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { DaemonServer, checkHealth } from '../src/daemon.js';

const TEST_PORT = 18999; // non-standard port to avoid conflicts
const TEST_HOST = '127.0.0.1';

describe('DaemonServer', () => {
  let server: DaemonServer;

  beforeEach(() => {
    // Clean up any stale PID file from previous test runs
    try { fs.unlinkSync('/tmp/ceki-daemon.pid'); } catch { /* ignore */ }
    server = new DaemonServer(TEST_HOST, TEST_PORT);
  });

  afterEach(async () => {
    try { await server.stop(); } catch { /* ignore */ }
  });

  it('starts HTTP server and responds to /health', async () => {
    await server.start();
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/health`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe('number');
  });

  it('returns 405 on non-POST / non-GET requests', async () => {
    await server.start();
    // PUT
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/health`, { method: 'PUT' });
    expect(resp.status).toBe(405);
  });

  it('returns 404 on unknown endpoint', async () => {
    await server.start();
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/unknown`, { method: 'POST' });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.ok).toBe(false);
  });

  it('returns 400 on invalid JSON body', async () => {
    await server.start();
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/cdp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('invalid JSON');
  });

  it('creates PID file on start', async () => {
    await server.start();
    const pidContent = fs.readFileSync('/tmp/ceki-daemon.pid', 'utf-8').trim();
    expect(Number.parseInt(pidContent, 10)).toBeGreaterThan(0);
  });

  it('removes PID file on stop', async () => {
    await server.start();
    await server.stop();
    expect(fs.existsSync('/tmp/ceki-daemon.pid')).toBe(false);
  });

  it('start returns error when already running', async () => {
    await server.start();
    const server2 = new DaemonServer(TEST_HOST, TEST_PORT);
    await expect(server2.start()).rejects.toThrow(/already running/i);
  });

  it('stop is idempotent', async () => {
    await server.start();
    await server.stop();
    await server.stop(); // second stop should not throw
  });
});

describe('Screenshot via daemon HTTP roundtrip', () => {
  const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1 red pixel
  const TEST_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI4Q/SFhSRFJiMkVic4EzQjR0RSlFNkVUcCZS/9oADAMBAAIRAxEAPwC1//Z';
  let server: DaemonServer;
  const SESSION_ID = 'screenshot-test-sid';

  beforeEach(() => {
    try { fs.unlinkSync('/tmp/ceki-daemon.pid'); } catch { /* ignore */ }
    server = new DaemonServer(TEST_HOST, TEST_PORT);
  });

  afterEach(async () => {
    try { await server.stop(); } catch { /* ignore */ }
  });

  it('roundtrips PNG screenshot data through daemon HTTP', async () => {
    await server.start();

    // Inject mock browser into private _sessions
    const mockBrowser = {
      screenshot: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
        if (opts.format === 'png') {
          return Buffer.from(TEST_PNG_BASE64, 'base64');
        }
        // format === 'base64' with _cdpFormat: 'jpeg'
        return { data: TEST_JPEG_BASE64 };
      }),
    };
    const mockClient = { disconnect: vi.fn().mockResolvedValue(undefined) };
    (server as unknown as Record<string, unknown>)['_sessions'] = new Map([
      [SESSION_ID, { client: mockClient, browser: mockBrowser }],
    ]);

    // POST /screenshot (PNG)
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, full: false, format: 'png' }),
    });
    expect(resp.ok).toBe(true);

    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.result).toBeDefined();
    const result = body.result as Record<string, unknown>;
    expect(typeof result.data).toBe('string');
    expect((result.data as string).length).toBeGreaterThan(0);

    // What CLI does: Buffer.from(result.data, 'base64') + writeFileSync
    const imgBuf = Buffer.from(result.data as string, 'base64');
    expect(imgBuf.length).toBeGreaterThan(0);

    // Verify PNG magic header
    expect(imgBuf[0]).toBe(0x89);
    expect(imgBuf[1]).toBe(0x50); // P
    expect(imgBuf[2]).toBe(0x4E); // N
    expect(imgBuf[3]).toBe(0x47); // G

    // Verify roundtrip fidelity (binary compare, not padded base64 string)
    expect(imgBuf.equals(Buffer.from(TEST_PNG_BASE64, 'base64'))).toBe(true);
  });

  it('roundtrips JPEG screenshot data through daemon HTTP', async () => {
    await server.start();

    const mockBrowser = {
      screenshot: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
        if (opts.format === 'png') {
          return Buffer.from(TEST_PNG_BASE64, 'base64');
        }
        return { data: TEST_JPEG_BASE64 };
      }),
    };
    const mockClient = { disconnect: vi.fn().mockResolvedValue(undefined) };
    (server as unknown as Record<string, unknown>)['_sessions'] = new Map([
      [SESSION_ID, { client: mockClient, browser: mockBrowser }],
    ]);

    // POST /screenshot (JPEG)
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, full: false, format: 'jpeg' }),
    });
    expect(resp.ok).toBe(true);

    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.result).toBeDefined();
    const result = body.result as Record<string, unknown>;
    expect(typeof result.data).toBe('string');
    expect((result.data as string).length).toBeGreaterThan(0);

    // What CLI does: decode and write
    const imgBuf = Buffer.from(result.data as string, 'base64');
    expect(imgBuf.length).toBeGreaterThan(0);

    // Verify JPEG magic header (SOI marker FF D8)
    expect(imgBuf[0]).toBe(0xFF);
    expect(imgBuf[1]).toBe(0xD8);

    // Verify roundtrip fidelity (binary compare, not padded base64 string)
    expect(imgBuf.equals(Buffer.from(TEST_JPEG_BASE64, 'base64'))).toBe(true);
  });

  it('returns session error for invalid session_id (endpoint routing works)', async () => {
    await server.start();
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'no-such-sid', full: false, format: 'png' }),
    });
    expect(resp.status).toBe(404);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('session not found');
  });

  it('writes valid PNG file via simulated daemon+CLI roundtrip', async () => {
    // Simulate the full cmdScreenshot daemon path:
    //   _handleScreenshot → daemon HTTP response → _daemonRequest → decode → writeFileSync
    await server.start();

    const mockBrowser = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from(TEST_PNG_BASE64, 'base64')),
    };
    const mockClient = { disconnect: vi.fn().mockResolvedValue(undefined) };
    (server as unknown as Record<string, unknown>)['_sessions'] = new Map([
      [SESSION_ID, { client: mockClient, browser: mockBrowser }],
    ]);

    // Simulate _daemonRequest: POST, parse, return data.result
    const resp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID }),
    });
    const json = await resp.json() as { ok: boolean; result?: unknown };
    expect(json.ok).toBe(true);
    const result = json.result as { data: string };

    // Simulate CLI decode + write
    const tmpFile = `/tmp/test-screenshot-${Date.now()}.png`;
    const imgBuf = Buffer.from(result.data, 'base64');
    fs.writeFileSync(tmpFile, imgBuf);

    try {
      // Verify file: >0 bytes + PNG magic header
      const stat = fs.statSync(tmpFile);
      expect(stat.size).toBeGreaterThan(0);

      const header = Buffer.alloc(4);
      const fd = fs.openSync(tmpFile, 'r');
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      expect(header[0]).toBe(0x89);
      expect(header[1]).toBe(0x50);
      expect(header[2]).toBe(0x4E);
      expect(header[3]).toBe(0x47);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});

describe('checkHealth', () => {
  it('returns null when daemon is not running', async () => {
    const result = await checkHealth();
    expect(result).toBeNull();
  });

  it('returns health data when daemon is running', async () => {
    const server = new DaemonServer(TEST_HOST, TEST_PORT);
    await server.start();
    try {
      const result = await checkHealth(TEST_PORT);
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(typeof result!.pid).toBe('number');
    } finally {
      await server.stop();
    }
  });
});
