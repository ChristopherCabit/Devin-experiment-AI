import { z } from "zod";
import type { TurnLog } from "../engine/turns.js";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { WorldStore } from "../world/store.js";
import type { WorldSettings } from "./context.js";
import { syncRecords, syncState } from "./sync.js";
import { namedIn } from "./pipeline.js";

/**
 * Check & fix: compares a finished passage with the records and the story before it, and swaps only
 * the exact phrases that contradict them. The records are built from what the passage itself
 * mentions, so details that only turned out to matter once the text was written are still checked.
 */
export const CHECK_PROMPT = `You proofread a story passage for continuity against the game's records and the story before it. The passage is second person: the protagonist is "you".
List only statements in the PASSAGE that clearly contradict the records or the earlier story: amounts of money, prices, wages, debts, counts, who owns or holds what, where someone is, who is present or could hear, who said what earlier, times and deadlines, names, what a character could know, and any narration of the protagonist in the third person. Not style, not taste, and not new things the passage establishes that fit everything known. The passage describes what happens this turn, so changes it shows happening (a payment, someone leaving) are not contradictions; a wrong starting amount or a wrong total is.
For each, copy the exact text to replace character for character (as short as possible while unique in the passage) and give a replacement that fits the records and keeps the sentence working.
Output JSON: {"fixes":[{"quote":str,"replacement":str,"why":str}]}. {"fixes":[]} when nothing contradicts.`;

const Fixes = z.object({
  fixes: z.array(z.object({ quote: z.string().min(1), replacement: z.string(), why: z.string().catch("").default("") }).catch(null as never)).catch([]).transform((xs) => xs.filter(Boolean)),
});
export interface Fix {
  quote: string;
  replacement: string;
  why: string;
}
type Chat = { chat(req: ChatRequest): Promise<ChatResult> };

/** Replaces each quote that occurs exactly once; the rest are reported as skipped. */
export function applyFixes(text: string, fixes: readonly Fix[]): { text: string; applied: Fix[]; skipped: Fix[] } {
  const applied: Fix[] = [];
  const skipped: Fix[] = [];
  for (const f of fixes) {
    const at = text.indexOf(f.quote);
    if (at < 0 || text.indexOf(f.quote, at + 1) >= 0 || f.quote === f.replacement) {
      skipped.push(f);
      continue;
    }
    text = text.slice(0, at) + f.replacement + text.slice(at + f.quote.length);
    applied.push(f);
  }
  return { text, applied, skipped };
}

export async function checkPassage(
  llm: Chat,
  store: WorldStore,
  log: TurnLog,
  playerId: string,
  s: WorldSettings,
  said: string,
  prose: string,
): Promise<{ text: string; applied: Fix[]; skipped: Fix[]; cost: number }> {
  const thorough = s.checkThorough;
  const earlier = log.history(thorough ? 9 : 4).slice(0, -1).filter((t) => t.output);
  const rec = syncRecords(store, playerId, [...namedIn(store, prose), ...namedIn(store, said)].filter((c) => c.id !== playerId));
  const res = await llm.chat({
    model: thorough ? s.syncModel : s.parserModel,
    json: true,
    maxTokens: thorough ? 3000 : 700,
    temperature: 0,
    reasoning: thorough ? "default" : "off",
    messages: [
      { role: "system", content: CHECK_PROMPT + (s.corrections.trim() ? `\nPlayer corrections (always true): ${s.corrections.trim()}` : "") },
      {
        role: "user",
        content: [
          "Records at the start of this turn:",
          rec.text,
          "",
          "Story before it:",
          ...earlier.map((t) => `${t.input ? `> ${t.input}\n` : ""}${thorough ? t.output : (t.output ?? "").slice(-1500)}`),
          "",
          ...(said ? [`Protagonist this turn: ${said}`, ""] : []),
          `PASSAGE:\n${prose}`,
        ].join("\n"),
      },
    ],
  });
  let fixes: Fix[] = [];
  try {
    fixes = Fixes.parse(JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim())).fixes;
  } catch {
    return { text: prose, applied: [], skipped: [], cost: res.costUsd };
  }
  return { ...applyFixes(prose, fixes), cost: res.costUsd };
}

export interface Settled {
  cost: number;
  text: string;
  applied: Fix[];
  skipped: Fix[];
  notes: string[];
}

/**
 * Finishes turn `n`: optionally checks and fixes the passage, then brings the records in line with
 * it. Both land in the same undoable turn. A repeat check first takes back that turn's earlier sync,
 * so the passage is compared with the records as they stood before it.
 */
export async function settleTurn(
  deps: { store: WorldStore; log: TurnLog; llm: Chat; playerId: string },
  s: WorldSettings,
  n: number,
  opts: { check: boolean; advanced?: number },
): Promise<Settled> {
  const { store, log, llm, playerId } = deps;
  const out: Settled = { cost: 0, text: "", applied: [], skipped: [], notes: [] };
  if (log.history(1)[0]?.n !== n) return out;
  log.unamend(n);
  const rec = log.history(1)[0];
  if (!rec?.output) return out;
  out.text = rec.output;
  if (opts.check) {
    const c = await checkPassage(llm, store, log, playerId, s, rec.input, rec.output);
    out.cost += c.cost;
    out.applied = c.applied;
    out.skipped = c.skipped;
    if (c.text !== rec.output && log.history(1)[0]?.n === n) {
      log.amend(n, [], c.text);
      store.setMeta(`vec:${n}`, null);
      out.text = c.text;
    }
  }
  if (s.stateSync && log.history(1)[0]?.n === n) {
    const advanced = opts.advanced ?? rec.ops.reduce((m: number, o) => m + ((o as { op?: string }).op === "time_advance" ? Number((o as { minutes?: number }).minutes ?? 0) : 0), 0);
    const r = await syncState(llm, store, playerId, s, rec.input, out.text, advanced, namedIn(store, out.text).filter((c) => c.id !== playerId));
    out.cost += r.cost;
    out.notes = r.notes;
    if (log.history(1)[0]?.n === n) log.amend(n, [{ source: "engine", ops: r.ops }], undefined, true);
  }
  return out;
}
