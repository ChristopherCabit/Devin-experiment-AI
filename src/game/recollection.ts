import type { TurnLog, TurnRecord } from "../engine/turns.js";
import type { WorldStore } from "../world/store.js";
import type { Entity } from "../world/types.js";
import { approxTokens, clockAt, turnBlock } from "./context.js";

/**
 * What a turn means to the people in it. Stored per turn under `mem:<n>` and tied to the
 * turn's `created_at` so an undone and replaced turn never inherits a stale entry.
 */
export interface MemoryIndex {
  at: number;
  /** Characters who witnessed it (the protagonist always did). */
  w: string[];
  /** People, places and objects it involves: the links of the memory web. */
  e: string[];
  /** Significance 0 routine .. 3 life-marking. */
  s: number;
  /** Characters for whom it was personally important beyond `s`. */
  m?: string[];
  /** In-game minute it was last recalled; recalling resets fading. */
  r?: number;
}

const DAY = 1440;
const HALF_LIFE_DAYS = [4, 12, 60, 400];
const BASE = [0.35, 0.55, 0.8, 1];
const SURFACED = "mem_surfaced";

const cache = new WeakMap<WorldStore, Map<number, MemoryIndex>>();
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? [];

/** Finds the known people, places and objects a text mentions, by name or alias. */
export function entityMatcher(store: WorldStore, playerId: string): (text: string) => string[] {
  const names = new Map<string, Set<string>>();
  const add = (name: string, id: string) => {
    const k = tokens(name).join(" ");
    if (k.length < 3) return;
    const set = names.get(k) ?? new Set<string>();
    set.add(id);
    names.set(k, set);
  };
  for (const e of store.allEntities()) {
    if (e.id === playerId) continue;
    for (const n of [e.name, ...e.aliases]) {
      add(n, e.id);
      const first = n.split(/\s+/)[0] ?? "";
      if (e.kind === "character" && first !== n && /^[A-Z][a-z]{2,}/.test(first)) add(first, e.id);
    }
  }
  return (text) => {
    const w = tokens(text).map((x) => x.replace(/['’]s$/, ""));
    const out = new Set<string>();
    for (let i = 0; i < w.length; i++)
      for (let k = 1; k <= 4 && i + k <= w.length; k++) for (const id of names.get(w.slice(i, i + k).join(" ")) ?? []) out.add(id);
    return [...out];
  };
}

/** Records who saw a turn, what it links to and how much it mattered. */
export function recordMemory(store: WorldStore, playerId: string, turn: TurnRecord, witnesses: string[], significance: number, movedFor: string[] = []): void {
  const links = new Set(entityMatcher(store, playerId)(turnBlock(turn)));
  for (const w of witnesses) links.add(w);
  const room = store.getEntity(store.getEntity(playerId)?.parent_id ?? "");
  if (room) links.add(room.id);
  links.delete(playerId);
  const idx: MemoryIndex = {
    at: turn.created_at,
    w: [...new Set(witnesses)].filter((x) => x !== playerId),
    e: [...links],
    s: Math.max(0, Math.min(3, Math.round(significance))),
    ...(movedFor.length ? { m: movedFor } : {}),
  };
  store.setMeta(`mem:${turn.n}`, idx);
  (cache.get(store) ?? cache.set(store, new Map()).get(store))?.set(turn.n, idx);
}

/** The memory record of a turn. Turns from before the index existed get one inferred from who and what they name. */
export function memoryOf(store: WorldStore, playerId: string, t: TurnRecord, match?: (text: string) => string[]): MemoryIndex {
  const c = cache.get(store) ?? cache.set(store, new Map()).get(store) ?? new Map<number, MemoryIndex>();
  const hit = c.get(t.n);
  if (hit && hit.at === t.created_at) return hit;
  const stored = store.getMeta<MemoryIndex | null>(`mem:${t.n}`, null);
  let idx: MemoryIndex;
  if (stored && stored.at === t.created_at) idx = stored;
  else {
    const e = (match ?? entityMatcher(store, playerId))(turnBlock(t));
    idx = { at: t.created_at, w: e.filter((id) => store.getEntity(id)?.kind === "character"), e, s: 1 };
  }
  c.set(t.n, idx);
  return idx;
}

/** Marks memories as just recalled, which resets their fading. */
export function rehearse(store: WorldStore, playerId: string, turns: TurnRecord[], now: number): void {
  for (const t of turns) {
    const idx = memoryOf(store, playerId, t);
    idx.r = now;
    store.setMeta(`mem:${t.n}`, idx);
  }
}

/**
 * How easily `who` can bring this memory back, 0..1. Anything from the last day or so is there;
 * older memories fade at a rate set by their significance, and recalling one refreshes it.
 */
export function strength(idx: MemoryIndex, clock: number, now: number, who?: string): number {
  if (now - clock <= 1.5 * DAY) return 1;
  const s = Math.min(3, idx.s + (who && idx.m?.includes(who) ? 1 : 0));
  const since = (now - Math.max(clock, idx.r ?? 0)) / DAY;
  const fresh = idx.r !== undefined && now - idx.r <= 1.5 * DAY ? 0.9 : 0;
  return Math.max(fresh, (BASE[s] ?? 0.55) * Math.pow(0.5, since / (HALF_LIFE_DAYS[s] ?? 12)), s >= 3 ? 0.7 : 0.08);
}

export function clarity(v: number): string {
  return v >= 0.6 ? "remembers it clearly" : v >= 0.3 ? "remembers the main points; small details are hazy" : "only a faint memory: the gist, not the particulars";
}

/** A character in the scene, or the protagonist when `who` names them or nobody. */
export function resolveWho(store: WorldStore, playerId: string, who: string): Entity | null {
  const w = who.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!w) return null;
  const chars = store.entitiesOfKind("character");
  return (
    chars.find((c) => c.id.toLowerCase() === w) ??
    chars.find((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase() === w)) ??
    chars.find((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().split(/\s+/)[0] === w)) ??
    null
  );
}

export interface Surfaced {
  text: string;
  who: string;
  turns: TurnRecord[];
}

/**
 * Picks at most one older memory that something in the scene might stir in a character present.
 * Not deterministic: it depends on how strongly the scene links to the memory, how significant and
 * fresh the memory is, and chance. Memories that came up recently are held back, so the same object
 * doesn't bring back the same thing every time.
 */
export function surfaceMemory(
  store: WorldStore,
  log: TurnLog,
  opts: { playerId: string; before: number; present: Entity[]; cues: string[]; weak?: string[]; times: Map<number, number>; now: number; rng: () => number; budgetTokens: number },
): Surfaced | null {
  const { playerId, present, rng, now } = opts;
  const people = present.filter((c) => c.id !== playerId && !(c.props as { group?: unknown }).group).slice(0, 4);
  if (!people.length || opts.budgetTokens < 150) return null;
  const all = log.history(5000);
  const past = all.filter((t) => t.n < opts.before && t.kind !== "author" && t.output.trim());
  if (past.length < 3) return null;
  const turnNo = log.lastTurn() + 1;
  const surfaced = store.getMeta<Record<string, number>>(SURFACED, {});
  const match = entityMatcher(store, playerId);
  const room = store.getEntity(store.getEntity(playerId)?.parent_id ?? "")?.id;
  const idxs = past.map((t) => memoryOf(store, playerId, t, match));
  // People who are simply around are a weak cue; a particular object, place or absent person is a strong one.
  const weak = new Set([...people.map((c) => c.id), ...(opts.weak ?? []), ...(room ? [room] : [])]);
  const cands: { who: Entity; i: number; why: string[]; weight: number }[] = [];
  for (const who of people) {
    const mine = idxs.map((x, i) => ({ x, i })).filter(({ x }) => x.w.includes(who.id));
    if (!mine.length) continue;
    const df = new Map<string, number>();
    for (const { x } of mine) for (const e of x.e) df.set(e, (df.get(e) ?? 0) + 1);
    const cues = opts.cues.filter((c) => c !== who.id && c !== playerId);
    const lastAny = Math.max(0, ...Object.entries(surfaced).filter(([k]) => k.startsWith(`${who.id}|`)).map(([, v]) => v));
    const busy = turnNo - lastAny < 6 ? 0.25 : 1;
    for (const { x, i } of mine) {
      const shared = cues.filter((c) => x.e.includes(c));
      // Routine moments don't come back on their own, and only notable ones come back from mere company.
      if (!shared.length || x.s === 0 || (x.s < 2 && shared.every((c) => weak.has(c)))) continue;
      // Rare links (a carved fox) stir more than ever-present ones (the room they live in).
      const rel = shared.reduce((a, c) => a + Math.log((mine.length + 1) / (df.get(c) ?? 1)) * (weak.has(c) ? 0.35 : 1), 0);
      if (rel < 0.8) continue;
      const t = past[i] as TurnRecord;
      const last = surfaced[`${who.id}|${t.n}|${t.created_at}`];
      const novelty = last === undefined ? 1 : Math.min(1, Math.max(0, (turnNo - last - 30) / 150));
      const s = strength(x, opts.times.get(t.n) ?? 0, now, who.id);
      const weight = rel * s * novelty * (0.25 + x.s / 2) * busy;
      if (weight > 0) cands.push({ who, i, why: shared, weight });
    }
  }
  if (!cands.length) return null;
  const total = cands.reduce((a, c) => a + c.weight, 0);
  if (rng() >= Math.min(0.3, 1 - Math.exp(-total * 0.15))) return null;
  let roll = rng() * total;
  const pick = cands.find((c) => (roll -= c.weight) <= 0) ?? (cands[cands.length - 1] as (typeof cands)[number]);
  const t = past[pick.i] as TurnRecord;
  const prev = past[pick.i - 1];
  const withPrev = prev && approxTokens(turnBlock(prev)) + approxTokens(turnBlock(t)) + 80 <= opts.budgetTokens;
  if (!withPrev && approxTokens(turnBlock(t)) + 80 > opts.budgetTokens) return null;
  const turns = withPrev && prev ? [prev, t] : [t];
  const by = pick.why.map((id) => store.getEntity(id)?.name).filter(Boolean).slice(0, 3).join(", ");
  const s = strength(idxs[pick.i] as MemoryIndex, opts.times.get(t.n) ?? 0, now, pick.who.id);
  surfaced[`${pick.who.id}|${t.n}|${t.created_at}`] = turnNo;
  const keep = Object.entries(surfaced).sort((a, b) => b[1] - a[1]).slice(0, 300);
  store.setMeta(SURFACED, Object.fromEntries(keep));
  rehearse(store, playerId, [t], now);
  return {
    who: pick.who.id,
    turns,
    text: `${pick.who.name}, stirred by ${by} (${clockAt(opts.times.get(t.n) ?? 0)}, turn ${t.n}; ${clarity(s)}):\n${turns.map(turnBlock).join("\n\n")}`,
  };
}
