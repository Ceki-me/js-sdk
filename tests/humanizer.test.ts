import { describe, it, expect } from 'vitest';
import { HumanProfile } from '../src/humanize/profile.js';
import { Humanizer } from '../src/humanize/humanizer.js';

describe('HumanProfile.loadPreset()', () => {
  it('natural preset returns correct profile', () => {
    const p = HumanProfile.loadPreset('natural');
    expect(p.name).toBe('natural');
    expect(p.raw.typing?.wpm).toBe(110);
    expect(p.raw.typing?.jitter).toBe(0.35);
    expect(p.raw.pre_action_ms?.click).toEqual([80, 350]);
    expect(p.raw.post_action_ms?.navigate).toEqual([400, 1800]);
  });

  it('careful preset returns correct profile', () => {
    const p = HumanProfile.loadPreset('careful');
    expect(p.name).toBe('careful');
    expect(p.raw.typing?.wpm).toBe(80);
    expect(p.raw.typing?.jitter).toBe(0.4);
    expect(p.raw.pre_action_ms?.click).toEqual([200, 600]);
    expect(p.raw.post_action_ms?.navigate).toEqual([800, 3000]);
  });

  it('throws on unknown preset', () => {
    expect(() => HumanProfile.loadPreset('nonexistent')).toThrow('not found');
  });
});

describe('HumanProfile.fromDict()', () => {
  it('deep-merges with defaults', () => {
    const p = HumanProfile.fromDict({
      name: 'custom',
      typing: { wpm: 200 },
    });
    expect(p.name).toBe('custom');
    // Overridden
    expect(p.raw.typing?.wpm).toBe(200);
    // Merged from defaults
    expect(p.raw.typing?.jitter).toBe(0.35);
    expect(p.raw.pre_action_ms?.click).toEqual([80, 350]);
  });

  it('preserves array values without merging', () => {
    const p = HumanProfile.fromDict({
      pre_action_ms: { click: [10, 20] },
    });
    expect(p.raw.pre_action_ms?.click).toEqual([10, 20]);
  });
});

describe('Humanizer', () => {
  it('before("click") produces delay in expected range', async () => {
    const profile = HumanProfile.fromDict({
      rng_seed: 42,
      pre_action_ms: { click: [100, 200] },
    });
    const h = new Humanizer(profile);

    const start = Date.now();
    await h.before('click');
    const elapsed = Date.now() - start;

    // Delay should be between 100 and 200ms (with some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(250);
  });

  it('after("navigate") produces delay in expected range', async () => {
    const profile = HumanProfile.fromDict({
      rng_seed: 42,
      post_action_ms: { navigate: [50, 150] },
    });
    const h = new Humanizer(profile);

    const start = Date.now();
    await h.after('navigate');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it('before() with [0,0] range returns immediately', async () => {
    const profile = HumanProfile.fromDict({
      rng_seed: 42,
      pre_action_ms: { screenshot: [0, 0] },
    });
    const h = new Humanizer(profile);

    const start = Date.now();
    await h.before('screenshot');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('typeDelay() returns positive number', () => {
    const profile = HumanProfile.fromDict({ rng_seed: 42 });
    const h = new Humanizer(profile);

    const delay = h.typeDelay();
    expect(delay).toBeGreaterThan(0);
    expect(typeof delay).toBe('number');
  });

  it('typeDelay() is at least 20ms (clamped)', () => {
    const profile = HumanProfile.fromDict({
      rng_seed: 42,
      typing: { wpm: 999999 }, // Extremely fast would produce tiny delays
    });
    const h = new Humanizer(profile);

    const delay = h.typeDelay();
    expect(delay).toBeGreaterThanOrEqual(20);
  });
});

describe('HumanProfile helpers', () => {
  it('getRange() returns correct tuple', () => {
    const p = HumanProfile.loadPreset('natural');
    const [lo, hi] = p.getRange('click', 'pre');
    expect(lo).toBe(80);
    expect(hi).toBe(350);
  });

  it('getRange() returns [0,0] for unknown action', () => {
    const p = HumanProfile.loadPreset('natural');
    const [lo, hi] = p.getRange('unknown_action', 'pre');
    expect(lo).toBe(0);
    expect(hi).toBe(0);
  });

  it('typingInterval() returns correct value', () => {
    const p = HumanProfile.loadPreset('natural');
    // 60000 / (110 * 5) = 109.09...
    expect(p.typingInterval()).toBeCloseTo(109.09, 0);
  });

  it('toDict() returns a deep copy', () => {
    const p = HumanProfile.loadPreset('natural');
    const dict = p.toDict();
    dict.typing!.wpm = 999;
    expect(p.raw.typing?.wpm).toBe(110); // Original unchanged
  });

  it('toJSON() returns valid JSON string', () => {
    const p = HumanProfile.loadPreset('natural');
    const json = p.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.typing.wpm).toBe(110);
  });
});
