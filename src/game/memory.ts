import type { TurnLog, TurnRecord } from "../engine/turns.js";
import type { ChatRequest } from "../llm/client.js";
import type { WorldStore } from "../world/store.js";
import { approxTokens, clockAt, turnBlock } from "./context.js";
import { clarity, entityMatcher, memoryOf, strength } from "./recollection.js";

/** A summary of a run of turns; `sig` ties it to the exact last turn so undone/replaced turns invalidate it. */
export interface Chapter {
  from: number;
  to: number;
  sig: string;
  text: string;
  /** In-game clock at the start and end of the chapter, when known. */
  start?: number;
  end?: number;
}

export const CHAPTER_TURNS = 10;
const KEY = "chapters";

interface Chat {
  chat(req: ChatRequest): Promise<{ text: string; costUsd: number }>;
}

const sig = (t: TurnRecord) => `${t.created_at}|${t.output.slice(0, 80)}`;
const told = (t: TurnRecord) => t.kind !== "author" && !(t.kind === "system" && !t.output);
const block = turnBlock;

export function validChapters(store: WorldStore, log: TurnLog): Chapter[] {
  const chapters = store.getMeta<Chapter[]>(KEY, []);
  if (!chapters.length) return [];
  const turns = new Map(log.history(log.lastTurn() - (chapters[0]?.to ?? 0) + 2).map((t) => [t.n, t]));
  const out: Chapter[] = [];
  for (const c of chapters) {
    const t = turns.get(c.to);
    if (!t || sig(t) !== c.sig) break;
    out.push(c);
  }
  return out;
}

/** Summarises the turns since the last chapter once there are enough of them. Returns cost. */
export async function updateChapters(store: WorldStore, log: TurnLog, llm: Chat, model: string, corrections = ""): Promise<number> {
  const chapters = validChapters(store, log);
  if (chapters.length !== store.getMeta<Chapter[]>(KEY, []).length) store.setMeta(KEY, chapters);
  const last = chapters.at(-1)?.to ?? 0;
  if (log.lastTurn() - last < CHAPTER_TURNS) return 0;
  const turns = log.history(log.lastTurn() - last).filter((t) => t.n > last);
  const end = turns.at(-1);
  const text = turns.filter(told).map(block).join("\n\n");
  if (!end || !text.trim()) return 0;
  const res = await llm.chat({
    model,
    maxTokens: 600,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          'Summarise this chapter of an interactive story as long-term memory for its narrator. At most 180 words, past tense, the protagonist is "you". Keep concrete facts a later scene must not contradict: who did and said what, promises, debts, changes in relationships, injuries, where items were left and why, names, unresolved threads. No commentary, no style.' +
          ' Lines starting "> You say:" are the protagonist\'s words and "> You:" their actions; never credit them to anyone else.' +
          (corrections.trim() ? ` The player's corrections override the chapter where they conflict; summarise as if they were always true: ${corrections.trim()}` : ""),
      },
      { role: "user", content: `${chapters.length ? `Previous chapter: ${chapters.at(-1)?.text}\n\n` : ""}Chapter:\n${text}` },
    ],
  });
  const summary = res.text.trim().slice(0, 2000);
  const times = turnClock(turns, store.getMeta<number>("clock_minutes", 0));
  const start = turns[0] ? times.get(turns[0].n) : undefined;
  if (summary) store.setMeta(KEY, [...chapters, { from: last + 1, to: end.n, sig: sig(end), text: summary, start, end: times.get(end.n) }]);
  return res.costUsd;
}

/** Chapter summaries older than the verbatim story window: the latest few, then older ones that mention who or where is in the scene. */
export function chapterContext(store: WorldStore, log: TurnLog, before: number, cues: string[], budgetTokens: number): string {
  const older = validChapters(store, log).filter((c) => c.to < before);
  if (!older.length) return "";
  const words = cues.map((c) => c.toLowerCase()).filter((c) => c.length > 2);
  const relevant = (c: Chapter) => words.some((w) => c.text.toLowerCase().includes(w));
  const order = [...older.slice(-3).reverse(), ...older.slice(0, -3).reverse().filter(relevant), ...older.slice(0, -3).reverse()];
  const picked = new Set<Chapter>();
  let used = 0;
  for (const c of order) {
    if (picked.has(c)) continue;
    used += approxTokens(c.text) + 8;
    if (used > budgetTokens) break;
    picked.add(c);
  }
  return older
    .filter((c) => picked.has(c))
    .map((c) => `${c.start !== undefined && c.end !== undefined ? `${clockAt(c.start)} to ${clockAt(c.end)}, t` : "T"}urns ${c.from}-${c.to}: ${c.text}`)
    .join("\n");
}

/** A captured meta value: the raw row, its JSON text, or the value itself. */
function metaNumber(raw: unknown): number {
  const v = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
  const n = Number(typeof v === "string" ? JSON.parse(v) : v);
  return Number.isFinite(n) ? n : 0;
}

/** In-game clock at the end of each turn, worked back from the current clock through each turn's recorded clock change. */
export function turnClock(turns: TurnRecord[], now: number): Map<number, number> {
  const out = new Map<number, number>();
  let t = now;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as TurnRecord;
    out.set(turn.n, t);
    const c = turn.changes.find((x) => x.table === "meta" && x.key === "clock_minutes");
    if (c) t = metaNumber(c.before);
  }
  return out;
}

const STOP = new Set(
  "about above after again against also among another around away back because been before behind being below between both came cannot come could didn does doing done down during each even ever every from further gets give goes going gone good have having here hers herself himself into itself just keep know last least left like little look made make many might more most much must myself near never next none nothing once only other ought ours over quite rather really right said same says seem seen should since some something still such sure take than that their theirs them then there these they thing think this those though through thus told toward under until upon very want were what when where which while whom whose will with within without would year your yours yourself".split(" "),
);
const terms = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) ?? []).map((w) => w.replace(/['’]s$/, "")).filter((w) => !STOP.has(w)));

/** Verbatim passages from before the story window that share rare words with what is happening now, with a turn either side and the in-game time. */
export interface RecallOptions {
  playerId?: string;
  /** Recall as this character: only what they witnessed, weighted by how well they'd remember it. */
  who?: string;
  /** Follow the memory web from the best match to one linked memory. */
  linked?: boolean;
  onPick?: (turns: TurnRecord[]) => void;
}

export function recallPassages(store: WorldStore, log: TurnLog, before: number, query: string, budgetTokens: number, lookup = false, opts: RecallOptions = {}): string {
  if (budgetTokens < 200) return "";
  const all = log.history(5000);
  const now = store.getMeta<number>("clock_minutes", 0);
  const times = turnClock(all, now);
  const { playerId, who } = opts;
  const match = playerId ? entityMatcher(store, playerId) : undefined;
  const idx = (t: TurnRecord) => (playerId ? memoryOf(store, playerId, t, match) : null);
  const past = all.filter((t) => t.n < before && told(t) && (!who || !!idx(t)?.w.includes(who)));
  if (past.length < (who ? 1 : 3)) return "";
  const held = (t: TurnRecord) => {
    const x = idx(t);
    return x ? strength(x, times.get(t.n) ?? 0, now, who) : 1;
  };
  const bags = past.map((t) => terms(turnBlock(t)));
  const df = new Map<string, number>();
  for (const b of bags) for (const w of b) df.set(w, (df.get(w) ?? 0) + 1);
  const common = Math.max(2, past.length * 0.2);
  // A deliberate lookup names what it wants, so any shared word counts; automatic recall needs two rare ones.
  const q = [...terms(query)].filter((w) => (df.get(w) ?? 0) > 0 && (df.get(w) ?? 0) <= (lookup ? Math.max(2, past.length * 0.5) : common));
  if (!q.length) return "";
  const idf = (w: string) => Math.log((past.length + 1) / (df.get(w) ?? 1));
  const need = lookup ? 0 : Math.max(3, Math.log(past.length + 1));
  const minShared = lookup ? Math.min(2, q.length) : 2;
  const hits = past
    .map((_, i) => {
      const shared = q.filter((w) => bags[i]?.has(w));
      const score = shared.reduce((a, w) => a + idf(w), 0);
      return { i, shared: shared.length, score, rank: playerId ? score * (0.5 + held(past[i] as TurnRecord)) : score };
    })
    .filter((x) => x.shared >= minShared && x.score >= need)
    .sort((a, b) => b.rank - a.rank);
  const picked: [number, number][] = [];
  let used = 0;
  for (const h of hits) {
    if (picked.length >= 3) break;
    if (picked.some(([a, b]) => h.i >= a - 1 && h.i <= b + 1)) continue;
    const a = Math.max(0, h.i - 1);
    const b = Math.min(past.length - 1, h.i + 1);
    const cost = past.slice(a, b + 1).reduce((n, t) => n + approxTokens(turnBlock(t)), 0) + 20;
    if (used + cost > budgetTokens) continue;
    used += cost;
    picked.push([a, b]);
  }
  const name = who ? (store.getEntity(who)?.name ?? who) : "";
  const head = (a: number, b: number) => {
    const first = past[a] as TurnRecord;
    const last = past[b] as TurnRecord;
    return `${clockAt(times.get(first.n) ?? 0)} (turns ${first.n}-${last.n}${who ? `; ${name} ${clarity(Math.max(...past.slice(a, b + 1).map(held)))}` : ""})`;
  };
  const out = picked
    .sort((x, y) => x[0] - y[0])
    .map(([a, b]) => `### ${head(a, b)}\n${past.slice(a, b + 1).map(turnBlock).join("\n\n")}`);
  const chosen = picked.flatMap(([a, b]) => past.slice(a, b + 1));
  const top = hits.find((h) => picked.some(([a, b]) => h.i >= a && h.i <= b));
  if (opts.linked && playerId && top) {
    const room = store.getEntity(store.getEntity(playerId)?.parent_id ?? "")?.id;
    const from = idx(past[top.i] as TurnRecord)?.e ?? [];
    const edf = new Map<string, number>();
    for (const t of past) for (const e of idx(t)?.e ?? []) edf.set(e, (edf.get(e) ?? 0) + 1);
    const skip = new Set([playerId, who, room]);
    const link = past
      .map((t, i) => {
        const shared = (idx(t)?.e ?? []).filter((e) => !skip.has(e) && from.includes(e));
        return { i, t, shared, score: shared.reduce((a, e) => a + Math.log((past.length + 1) / (edf.get(e) ?? 1)), 0) * (0.5 + held(t)) };
      })
      .filter((x) => x.score > 0.5 && !picked.some(([a, b]) => x.i >= a - 1 && x.i <= b + 1))
      .sort((a, b) => b.score - a.score)[0];
    if (link && used + approxTokens(turnBlock(link.t)) + 40 <= budgetTokens) {
      const via = link.shared.map((e) => store.getEntity(e)?.name).filter(Boolean).slice(0, 3).join(", ");
      out.push(`### Linked memory (also involves ${via}): ${clockAt(times.get(link.t.n) ?? 0)} (turn ${link.t.n}${who ? `; ${name} ${clarity(held(link.t))}` : ""})\n${turnBlock(link.t)}`);
      chosen.push(link.t);
    }
  }
  if (chosen.length) opts.onPick?.(chosen);
  return out.join("\n\n");
}
