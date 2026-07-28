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
