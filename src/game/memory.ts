import type { TurnLog, TurnRecord } from "../engine/turns.js";
import type { ChatRequest } from "../llm/client.js";
import type { WorldStore } from "../world/store.js";
import { approxTokens, turnBlock } from "./context.js";

/** A summary of a run of turns; `sig` ties it to the exact last turn so undone/replaced turns invalidate it. */
export interface Chapter {
  from: number;
  to: number;
  sig: string;
  text: string;
}

export const CHAPTER_TURNS = 10;
const KEY = "chapters";

interface Chat {
  chat(req: ChatRequest): Promise<{ text: string; costUsd: number }>;
}

const sig = (t: TurnRecord) => `${t.created_at}|${t.output.slice(0, 80)}`;
const told = (t: TurnRecord) => t.kind !== "author" && !(t.kind === "system" && !t.output);
const block = (t: TurnRecord) => turnBlock(t);

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
    maxTokens: 400,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          'Summarise this chapter of an interactive story as long-term memory for its narrator. At most 120 words, past tense, the protagonist is "you". Keep concrete facts a later scene must not contradict: who did and said what, promises, debts, changes in relationships, injuries, where items were left and why, names, unresolved threads. In any argument, debate or negotiation, say who held which side, by name ("you argued X; Mara insisted Y"); lines after "> You say:" are words the protagonist said. No commentary, no style.' +
          (corrections.trim() ? ` The player's corrections override the chapter where they conflict; summarise as if they were always true: ${corrections.trim()}` : ""),
      },
      { role: "user", content: `${chapters.length ? `Previous chapter: ${chapters.at(-1)?.text}\n\n` : ""}Chapter:\n${text}` },
    ],
  });
  const summary = res.text.trim().slice(0, 1500);
  if (summary) store.setMeta(KEY, [...chapters, { from: last + 1, to: end.n, sig: sig(end), text: summary }]);
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
    .map((c) => `Turns ${c.from}-${c.to}: ${c.text}`)
    .join("\n");
}
