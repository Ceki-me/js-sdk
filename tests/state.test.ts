import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveSession, loadSession, deleteSession, getLastSeenTs, updateLastSeenTs } from '../src/state.js';

const STATE_DIR = path.join(os.homedir(), '.ceki', 'sessions');
const TEST_SID = 'test-state-sid-' + Date.now();

beforeEach(() => {
  // Clean up any leftover test state
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${TEST_SID}.json`));
  } catch { /* ignore */ }
});

afterEach(() => {
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${TEST_SID}.json`));
  } catch { /* ignore */ }
});

describe('saveSession()', () => {
  it('creates file in correct directory', () => {
    saveSession(TEST_SID, { session_id: TEST_SID, foo: 'bar' });

    const filePath = path.join(STATE_DIR, `${TEST_SID}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.session_id).toBe(TEST_SID);
    expect(data.foo).toBe('bar');
    expect(data.updated_at).toBeDefined();
  });
});

describe('loadSession()', () => {
  it('reads saved session', () => {
    saveSession(TEST_SID, { session_id: TEST_SID, key: 'value' });

    const data = loadSession(TEST_SID);
    expect(data).not.toBeNull();
    expect(data!.session_id).toBe(TEST_SID);
    expect(data!.key).toBe('value');
  });

  it('returns null for non-existent session', () => {
    const data = loadSession('nonexistent-sid-xyz');
    expect(data).toBeNull();
  });
});

describe('deleteSession()', () => {
  it('removes file', () => {
    saveSession(TEST_SID, { session_id: TEST_SID });
    const filePath = path.join(STATE_DIR, `${TEST_SID}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    deleteSession(TEST_SID);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('does not throw for non-existent session', () => {
    expect(() => deleteSession('nonexistent-sid-xyz')).not.toThrow();
  });
});

describe('getLastSeenTs()', () => {
  it('returns last_seen_ts from state', () => {
    saveSession(TEST_SID, { session_id: TEST_SID, last_seen_ts: '2024-01-15T10:00:00Z' });

    const ts = getLastSeenTs(TEST_SID);
    expect(ts).toBe('2024-01-15T10:00:00Z');
  });

  it('returns null when no state exists', () => {
    const ts = getLastSeenTs('nonexistent-sid-xyz');
    expect(ts).toBeNull();
  });

  it('returns null when last_seen_ts is not set', () => {
    saveSession(TEST_SID, { session_id: TEST_SID });

    const ts = getLastSeenTs(TEST_SID);
    expect(ts).toBeNull();
  });
});

describe('updateLastSeenTs()', () => {
  it('updates the field', () => {
    saveSession(TEST_SID, { session_id: TEST_SID, last_seen_ts: null });

    updateLastSeenTs(TEST_SID, '2024-06-01T12:00:00Z');

    const ts = getLastSeenTs(TEST_SID);
    expect(ts).toBe('2024-06-01T12:00:00Z');
  });

  it('creates state if not exists', () => {
    updateLastSeenTs(TEST_SID, '2024-06-01T12:00:00Z');

    const data = loadSession(TEST_SID);
    expect(data).not.toBeNull();
    expect(data!.last_seen_ts).toBe('2024-06-01T12:00:00Z');
  });
});
