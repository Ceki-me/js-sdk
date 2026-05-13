import * as fs from 'node:fs';

export interface HumanProfileRaw {
  version?: number;
  name?: string;
  typing?: {
    wpm?: number;
    jitter?: number;
    thinking_pause_prob?: number;
    thinking_pause_ms?: [number, number];
    typo_prob?: number;
  };
  pre_action_ms?: Record<string, [number, number]>;
  post_action_ms?: Record<string, [number, number]>;
  mouse?: {
    move_before_click?: boolean;
    trajectory?: string;
  };
  rng_seed?: number | null;
}

const PRESETS: Record<string, HumanProfileRaw> = {
  natural: {
    version: 1,
    name: 'natural',
    typing: { wpm: 110, jitter: 0.35, thinking_pause_prob: 0.012, thinking_pause_ms: [300, 1200], typo_prob: 0.0 },
    pre_action_ms: { click: [80, 350], type: [120, 500], scroll: [50, 250], navigate: [0, 0], screenshot: [0, 0] },
    post_action_ms: { click: [150, 800], type: [150, 800], scroll: [200, 900], navigate: [400, 1800], screenshot: [0, 0] },
    mouse: { move_before_click: false, trajectory: 'off' },
    rng_seed: null,
  },
  careful: {
    version: 1,
    name: 'careful',
    typing: { wpm: 80, jitter: 0.4, thinking_pause_prob: 0.025, thinking_pause_ms: [400, 1800], typo_prob: 0.0 },
    pre_action_ms: { click: [200, 600], type: [250, 800], scroll: [100, 400], navigate: [0, 0], screenshot: [0, 0] },
    post_action_ms: { click: [400, 1500], type: [300, 1200], scroll: [300, 1200], navigate: [800, 3000], screenshot: [0, 0] },
    mouse: { move_before_click: false, trajectory: 'off' },
    rng_seed: null,
  },
};

const DEFAULTS: HumanProfileRaw = {
  version: 1,
  name: 'custom',
  typing: {
    wpm: 110,
    jitter: 0.35,
    thinking_pause_prob: 0.012,
    thinking_pause_ms: [300, 1200],
    typo_prob: 0.0,
  },
  pre_action_ms: {
    click: [80, 350],
    type: [120, 500],
    scroll: [50, 250],
    navigate: [0, 0],
    screenshot: [0, 0],
  },
  post_action_ms: {
    click: [150, 800],
    type: [150, 800],
    scroll: [200, 900],
    navigate: [400, 1800],
    screenshot: [0, 0],
  },
  mouse: {
    move_before_click: false,
    trajectory: 'off',
  },
  rng_seed: null,
};

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class HumanProfile {
  readonly name: string;
  readonly raw: HumanProfileRaw;

  constructor(name: string, raw: HumanProfileRaw) {
    this.name = name;
    this.raw = raw;
  }

  static fromDict(d: Record<string, unknown>): HumanProfile {
    const merged = deepMerge(
      DEFAULTS as unknown as Record<string, unknown>,
      d,
    ) as HumanProfileRaw;
    const name = (d.name as string) ?? 'custom';
    merged.name = name;
    return new HumanProfile(name, merged);
  }

  static load(filePath: string): HumanProfile {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return HumanProfile.fromDict(data);
  }

  static loadPreset(name: string): HumanProfile {
    const preset = PRESETS[name];
    if (!preset) {
      throw new Error(`Preset '${name}' not found. Available: ${Object.keys(PRESETS).join(', ')}`);
    }
    return HumanProfile.fromDict(preset as unknown as Record<string, unknown>);
  }

  getRange(action: string, phase: 'pre' | 'post'): [number, number] {
    const key = `${phase}_action_ms` as keyof HumanProfileRaw;
    const mapping = this.raw[key] as Record<string, [number, number]> | undefined;
    const pair = mapping?.[action];
    if (Array.isArray(pair) && pair.length === 2) {
      return [pair[0], pair[1]];
    }
    return [0, 0];
  }

  typingInterval(): number {
    const wpm = this.raw.typing?.wpm ?? 110;
    return 60_000 / (wpm * 5);
  }

  toDict(): HumanProfileRaw {
    return JSON.parse(JSON.stringify(this.raw)) as HumanProfileRaw;
  }

  toJSON(indent = 2): string {
    return JSON.stringify(this.raw, null, indent);
  }
}
