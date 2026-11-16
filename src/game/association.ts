import type { TurnLog, TurnRecord } from "../engine/turns.js";
import type { WorldStore } from "../world/store.js";
import type { Entity } from "../world/types.js";
import { approxTokens, clockAt, turnBlock } from "./context.js";
import { clarity, memoryOf, rehearse, strength } from "./recollection.js";

/**
 * Memories found by meaning. Each turn gets an embedding once (stored as int8 under `vec:<n>`, tied to the
 * turn's created_at like its memory record); a passage or the player's words are then compared against
 * the memories of the people present, so a synonym or metaphor can bring one back.
 */
export const EMBED_DIMS = 1024;
const PRIMED = "mem_primed";
const QUERY = "Instruct: Given a moment from a story, retrieve the earlier story event a character present would be reminded of\nQuery: ";

export type Embed = (texts: string[], query: boolean) => Promise<{ vectors: Float32Array[]; costUsd: number }>;

interface Stored {
  at: number;
  v: string;
}

export function encodeVector(v: ArrayLike<number>): string {
  let max = 1e-9;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i] ?? 0));
  let bin = "";
  for (let i = 0; i < v.length; i++) bin += String.fromCharCode((Math.round(((v[i] ?? 0) / max) * 127) + 256) % 256);
  return btoa(bin);
}

export function decodeVector(s: string): Float32Array {
  const bin = atob(s);
  const v = new Float32Array(bin.length);
  let n = 0;
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    v[i] = b > 127 ? b - 256 : b;
    n += (v[i] ?? 0) ** 2;
  }
  const k = 1 / Math.sqrt(n || 1);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) * k;
  return v;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  const k = 1 / Math.sqrt(n || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * k;
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

const vecs = new WeakMap<WorldStore, Map<number, { at: number; v: Float32Array }>>();

export function vectorOf(store: WorldStore, t: TurnRecord): Float32Array | null {
  const c = vecs.get(store) ?? vecs.set(store, new Map()).get(store) ?? new Map<number, { at: number; v: Float32Array }>();
  const hit = c.get(t.n);
  if (hit && hit.at === t.created_at) return hit.v;
  const s = store.getMeta<Stored | null>(`vec:${t.n}`, null);
  if (!s || s.at !== t.created_at) return null;
  const v = decodeVector(s.v);
  c.set(t.n, { at: s.at, v });
  return v;
}

export function queryText(text: string): string {
  return QUERY + text;
}

/** Embeds turns that have no vector yet, oldest first: the newest are still in the narrator's view anyway. */
export async function indexTurns(store: WorldStore, log: TurnLog, embed: Embed, batch = 256): Promise<number> {
  const todo = log
    .history(5000)
    .filter((t) => t.kind !== "author" && t.output.trim() && !vectorOf(store, t))
    .slice(0, batch);
  if (!todo.length) return 0;
  const r = await embed(
    todo.map((t) => turnBlock(t).slice(0, 6000)),
    false,
  );
  todo.forEach((t, i) => {
    const v = r.vectors[i];
    if (!v) return;
    store.setMeta(`vec:${t.n}`, { at: t.created_at, v: encodeVector(v) } satisfies Stored);
    vecs.get(store)?.delete(t.n);
  });
  return r.costUsd;
}

export interface Candidate {
  t: TurnRecord;
  prev: TurnRecord | undefined;
  v: Float32Array;
  /** Present characters who were there. */
  who: Entity[];
  s: number;
}

/** Older memories (before the visible story) that at least one character present was there for. */
export function candidates(store: WorldStore, log: TurnLog, playerId: string, before: number, present: Entity[]): Candidate[] {
  const people = present.filter((c) => c.id !== playerId && !(c.props as { group?: unknown }).group);
  if (!people.length) return [];
  const past = log.history(5000).filter((t) => t.n < before && t.kind !== "author" && t.output.trim());
  const out: Candidate[] = [];
  past.forEach((t, i) => {
    const v = vectorOf(store, t);
    if (!v) return;
    const idx = memoryOf(store, playerId, t);
    const who = people.filter((c) => idx.w.includes(c.id));
    if (who.length) out.push({ t, prev: past[i - 1], v, who, s: idx.s });
  });
  return out;
}

export interface Match {
  c: Candidate;
  /** How far it stands out from the rest of their memories, in standard deviations. */
  z: number;
  score: number;
}

/** Ranks candidates against a query by how much each stands out, so a vaguely similar crowd doesn't count. */
export function standouts(q: Float32Array, cands: Candidate[]): Match[] {
  if (cands.length < 3) return [];
  const sc = cands.map((c) => dot(q, c.v));
  const mean = sc.reduce((a, b) => a + b, 0) / sc.length;
  const sd = Math.sqrt(sc.reduce((a, b) => a + (b - mean) ** 2, 0) / sc.length) || 1;
  return cands.map((c, i) => ({ c, score: sc[i] ?? 0, z: ((sc[i] ?? 0) - mean) / sd })).sort((a, b) => b.z - a.z);
}

/** How far the best of n unrelated memories would stand out by chance alone; a real match has to beat it. */
export function chanceBar(n: number): number {
  return Math.sqrt(2 * Math.log(Math.max(2, n)));
}

export interface RecallContext {
  store: WorldStore;
  playerId: string;
  times: Map<number, number>;
  now: number;
  turnNo: number;
  rng: () => number;
}

const key = (t: TurnRecord) => `${t.n}|${t.created_at}`;

function novelty(ctx: RecallContext, t: TurnRecord): number {
  const last = ctx.store.getMeta<Record<string, number>>(PRIMED, {})[key(t)];
  return last === undefined ? 1 : Math.min(1, Math.max(0, (ctx.turnNo - last - 8) / 30));
}

function clearest(ctx: RecallContext, c: Candidate): number {
  const idx = memoryOf(ctx.store, ctx.playerId, c.t);
  return Math.max(...c.who.map((w) => strength(idx, ctx.times.get(c.t.n) ?? 0, ctx.now, w.id)));
}

/** Marks memories as having come to mind: they are held back for a while and their fading resets. */
export function markRecalled(ctx: RecallContext, ts: TurnRecord[]): void {
  const m = ctx.store.getMeta<Record<string, number>>(PRIMED, {});
  for (const t of ts) m[key(t)] = ctx.turnNo;
  ctx.store.setMeta(PRIMED, Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 300)));
  rehearse(ctx.store, ctx.playerId, ts, ctx.now);
}

/** The memory as the narrator sees it: whose it is, when, how clearly, and the passage itself. */
export function memoryText(ctx: RecallContext, c: Candidate, budgetTokens: number): string | null {
  const one = turnBlock(c.t);
  const withPrev = c.prev && approxTokens(turnBlock(c.prev)) + approxTokens(one) + 80 <= budgetTokens;
  if (!withPrev && approxTokens(one) + 80 > budgetTokens) return null;
  const ts = withPrev && c.prev ? [c.prev, c.t] : [c.t];
  return `${c.who.map((w) => w.name).join(" and ")} (${clockAt(ctx.times.get(c.t.n) ?? 0)}, turn ${c.t.n}; ${clarity(clearest(ctx, c))}):\n${ts.map(turnBlock).join("\n\n")}`;
}

/**
 * Memories close to the surface before the narrator writes, from what just happened and what the player
 * says. Something the player asks about directly comes back; others come up by chance, weighted by how
 * strongly they stand out, how significant and fresh they are, and how recently they last came up.
 */
export function primeMemories(ctx: RecallContext, cands: Candidate[], last: Float32Array | null, input: Float32Array | null, budgetTokens: number, most = 2): { text: string; turns: TurnRecord[] } {
  const best = new Map<Candidate, { z: number; asked: boolean }>();
  for (const [q, asked] of [
    [last, false],
    [input, true],
  ] as const) {
    if (!q) continue;
    for (const m of standouts(q, cands).slice(0, 8)) {
      const b = best.get(m.c);
      if (!b || m.z > b.z) best.set(m.c, { z: m.z, asked: asked || (b?.asked ?? false) });
    }
  }
  const picked: Candidate[] = [];
  const ranked = [...best.entries()].sort((a, b) => b[1].z - a[1].z);
  const bar = chanceBar(cands.length);
  for (const [c, { z, asked }] of ranked) if (asked && z >= Math.max(2.2, bar - 0.3) && novelty(ctx, c.t) > 0 && picked.length < most) picked.push(c);
  const pool = ranked
    .filter(([c, { z }]) => z >= Math.max(2.8, bar - 0.2) && !picked.includes(c))
    .map(([c, { z }]) => ({ c, w: Math.exp(z - bar) * clearest(ctx, c) * novelty(ctx, c.t) * (0.25 + c.s / 2) }))
    .filter((x) => x.w > 0);
  while (picked.length < most && pool.length) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    if (ctx.rng() >= Math.min(0.6, 1 - Math.exp(-total * 0.5))) break;
    let roll = ctx.rng() * total;
    const i = Math.max(0, pool.findIndex((x) => (roll -= x.w) <= 0));
    picked.push((pool.splice(i, 1)[0] as (typeof pool)[number]).c);
  }
  const parts: string[] = [];
  const turns: TurnRecord[] = [];
  let left = budgetTokens;
  for (const c of picked) {
    const text = memoryText(ctx, c, left);
    if (!text) continue;
    parts.push(text);
    turns.push(c.t);
    left -= approxTokens(text);
  }
  if (turns.length) markRecalled(ctx, turns);
  return { text: parts.join("\n\n"), turns };
}

/**
 * Checks a sentence of the passage being written: does it bring back an older memory for someone present?
 * Only a memory that clearly stands out counts, and even then it's chance, so the same cue doesn't always
 * bring back the same thing.
 */
export function stirredBy(ctx: RecallContext, q: Float32Array, cands: Candidate[], skip: Set<number>): Candidate | null {
  const top = standouts(q, cands).find((m) => !skip.has(m.c.t.n));
  // Early in a story there are few memories, and chance alone makes one look like a match; the floor stops that.
  const bar = Math.max(3.2, chanceBar(cands.length) + 0.4);
  if (!top || top.z < bar) return null;
  const p = Math.min(1, (top.z - bar + 0.4) / 0.8) * (0.5 + 0.5 * clearest(ctx, top.c)) * novelty(ctx, top.c.t);
  return ctx.rng() < p ? top.c : null;
}
