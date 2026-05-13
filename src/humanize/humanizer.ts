import { HumanProfile } from './profile.js';

function seededRandom(seed: number | null): () => number {
  if (seed === null || seed === undefined) {
    return Math.random;
  }
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function gaussianRandom(rng: () => number, mean: number, sigma: number): number {
  let u1: number, u2: number;
  do { u1 = rng(); } while (u1 === 0);
  u2 = rng();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * sigma;
}

export class Humanizer {
  readonly profile: HumanProfile;
  private _rng: () => number;

  constructor(profile: HumanProfile) {
    this.profile = profile;
    this._rng = seededRandom(profile.raw.rng_seed ?? null);
  }

  async before(action: string): Promise<void> {
    const [lo, hi] = this.profile.getRange(action, 'pre');
    if (lo === 0 && hi === 0) return;
    const delay = lo + this._rng() * (hi - lo);
    await sleep(delay);
  }

  async after(action: string): Promise<void> {
    const [lo, hi] = this.profile.getRange(action, 'post');
    if (lo === 0 && hi === 0) return;
    const delay = lo + this._rng() * (hi - lo);
    await sleep(delay);
  }

  typeDelay(): number {
    const typing = this.profile.raw.typing ?? {};
    const wpm = typing.wpm ?? 110;
    const jitter = typing.jitter ?? 0.35;
    const thinkProb = typing.thinking_pause_prob ?? 0;
    const thinkMs = typing.thinking_pause_ms ?? [300, 1200];

    const meanInterval = 60_000 / (wpm * 5);
    const sigma = meanInterval * jitter;

    let delay = gaussianRandom(this._rng, meanInterval, sigma);
    delay = Math.max(delay, 20);

    if (thinkProb > 0 && this._rng() < thinkProb) {
      delay += thinkMs[0] + this._rng() * (thinkMs[1] - thinkMs[0]);
    }

    return delay;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
