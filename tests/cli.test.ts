import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '../dist/cli.js');

function run(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 5000,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        code: error?.code != null ? (typeof error.code === 'number' ? error.code : null) : 0,
      });
    });
  });
}

describe('CLI', () => {
  it('--help exits 0, prints help text', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ceki-browser');
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('Commands:');
  });

  it('-h also prints help', async () => {
    const r = await run(['-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('--version exits 0, prints version', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('1.9.0');
  });

  it('-v also prints version', async () => {
    const r = await run(['-v']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('1.9.0');
  });

  it('missing CEKI_API_KEY exits 2 with error JSON on stderr', async () => {
    // Remove CEKI_API_KEY from env
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'CEKI_API_KEY' && v !== undefined) {
        cleanEnv[k] = v;
      }
    }

    const r = await run(['rent', '--schedule', '1'], { CEKI_API_KEY: '' });
    // The process should exit with code 2
    // execFile returns the exit code via error.code as a number
    expect(r.stderr).toContain('"error"');
    expect(r.stderr).toContain('CEKI_API_KEY');
  });

  it('unknown command exits 1 with error', async () => {
    const r = await run(['nonexistent-command'], { CEKI_API_KEY: 'test' });
    expect(r.stderr).toContain('Unknown command');
  });

  it('no arguments shows help', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('closeClient uses disconnect(), not close()', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf-8');
    const closeClientMatch = src.match(/async function closeClient[\s\S]*?\n\}/);
    expect(closeClientMatch).not.toBeNull();
    expect(closeClientMatch![0]).toContain('client.disconnect()');
    expect(closeClientMatch![0]).not.toContain('client.close()');
  });
});
