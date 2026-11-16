import type { Sheet } from "./types.js";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) so a split is identical on retry and in tests. */
export function seeded(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JITTER = [-1, 0, 0, 1];

/** A named group member: the group's sheet ±1 per stat, with an occasional much weaker or much stronger outlier. */
export function memberSheet(template: Sheet, rng: () => number): Sheet {
  const r = rng();
  const shift = r < 0.08 ? -2 - Math.floor(rng() * 2) : r > 0.92 ? 2 + Math.floor(rng() * 2) : 0;
  const tier = (v: number) => Math.max(0, Math.min(10, v + shift + (JITTER[Math.floor(rng() * JITTER.length)] ?? 0)));
  const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tier(v)]));
  const resources = structuredClone(template.resources);
  const hp = resources.hp;
  if (hp) {
    hp.max = Math.max(1, hp.max + shift * 2);
    hp.value = hp.max;
  }
  return {
    attributes: map(template.attributes),
    skills: map(template.skills),
    abilities: map(template.abilities),
    power_tier: tier(template.power_tier),
    resources,
    progress: {},
  };
}
