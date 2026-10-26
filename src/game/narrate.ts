import { LlmAborted, type ChatRequest, type ChatResult } from "../llm/client.js";

/**
 * Checks finished sentences of the passage for something that brings back a memory; returns which
 * sentence did and the memory, or null.
 */
export type Watch = (sentences: string[]) => Promise<{ index: number; memory: string } | null>;

export interface NarrateOptions {
  watch: Watch | null;
  /** Receives the raw text the player may see so far (still to be stripped of ops). */
  show: (raw: string) => void;
  maxPauses: number;
  /** The message that hands back the passage so far and the memory that came to mind. */
  resume: (soFar: string, memory: string) => string;
}

/** The raw text with op blocks, fences, tags and JSON lines blanked out, so offsets still line up. */
export function maskOps(raw: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let s = raw
    .replace(/<(ops?|state|updates)>[\s\S]*?<\/\1>/gi, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/<\/?(?:ops?|state|updates)\s*\/?>/gi, blank)
    .replace(/^[ \t]*[[{].*$/gm, blank)
    .replace(/<[^>\n]*$/, blank);
  const open = s.search(/```|<(?:ops?|state|updates|tool_call|parameter|arg_key|arg_value)\b/i);
  if (open >= 0) s = s.slice(0, open);
  return s;
}

const words = (s: string) => (s.match(/[A-Za-z0-9’']+/g) ?? []).length;

/** Finished sentences after `from` (short ones join the next), each as [start, end) offsets. */
export function sentencesFrom(masked: string, from: number, final: boolean): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  let s = from;
  const re = /[.!?…]+["”’)*_]*(?=\s)|\n[ \t]*\n/g;
  re.lastIndex = from;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const e = m.index + m[0].length;
    if (words(masked.slice(s, e)) >= 6) {
      out.push({ s, e });
      s = e;
    }
  }
  if (final && words(masked.slice(s)) > 0) out.push({ s, e: masked.length });
  return out;
}

/** Where a continuation stops repeating what was already written (0 when it doesn't). */
export function repeatEnd(kept: string, cont: string): number {
  const prose = maskOps(kept).replace(/\s+/g, " ").trim();
  const last = prose.split(/(?<=[.!?…]["”’)]*)\s+/).at(-1) ?? "";
  const tail = prose.slice(-Math.max(20, Math.min(40, last.length)));
  if (tail.length < 20) return 0;
  let flat = "";
  const pos: number[] = [];
  for (let i = 0; i < cont.length; i++) {
    const ch = cont[i] ?? "";
    if (/\s/.test(ch)) {
      if (flat.endsWith(" ")) continue;
      flat += " ";
    } else flat += ch;
    pos.push(i);
  }
  const at = flat.indexOf(tail);
  if (at < 0 || at > prose.length + 200) return 0;
  return (pos[at + tail.length - 1] ?? -1) + 1;
}

/**
 * Writes the passage the way a person remembers: as each sentence is finished it is checked against the
 * memories of the people present. When one comes to mind the writing stops before that sentence and
 * carries on from there with the memory in hand; nothing already written is redone, and the player's view
 * runs one checked sentence behind, so the stopped sentence is never shown.
 */
export async function narrate(llm: { chat(req: ChatRequest): Promise<ChatResult> }, req: ChatRequest, o: NarrateOptions): Promise<{ text: string; costUsd: number; pauses: number }> {
  let kept = "";
  let cost = 0;
  let pauses = 0;
  const late: Promise<number>[] = [];
  let messages = req.messages;
  for (;;) {
    const ctrl = new AbortController();
    const watch = pauses < o.maxPauses ? o.watch : null;
    let seg = "";
    let skip = -1;
    let start = 0;
    let shown = 0;
    let round = 0;
    let prev = "";
    let hit: { at: number; memory: string; sep: string } | null = null;
    const queue: { s: number; e: number; text: string; round: number }[] = [];
    let busy: Promise<void> | null = null;
    const pump = () => {
      if (busy || hit || !queue.length || !watch) return;
      const batch = queue.splice(0);
      busy = (async () => {
        const res = await watch(batch.map((b) => b.text)).catch(() => null);
        const b = res ? batch[res.index] : undefined;
        if (b && res && b.round === round && !hit) {
          hit = { at: b.s, memory: res.memory, sep: /^[ \t]*\n/.test(seg.slice(b.s)) ? "\n\n" : " " };
          ctrl.abort();
        } else if (!hit && batch.at(-1)?.round === round) {
          shown = Math.max(shown, batch.at(-1)?.e ?? 0);
          o.show(kept + seg.slice(0, shown));
        }
        busy = null;
        pump();
      })();
    };
    const take = (t: string, final: boolean) => {
      if (hit) return;
      if (kept && skip < 0) {
        if (!final && t.length < 120) return;
        skip = repeatEnd(kept, t);
      }
      const next = t.slice(Math.max(0, skip));
      if (!next.startsWith(seg.slice(0, Math.min(seg.length, 40)))) {
        round++;
        start = shown = 0;
        prev = "";
        queue.length = 0;
      }
      seg = next;
      if (!watch) return o.show(kept + seg);
      const masked = maskOps(seg);
      for (const { s, e } of sentencesFrom(masked, start, final)) {
        start = e;
        const text = masked.slice(s, e).replace(/\s+/g, " ").trim();
        queue.push({ s, e, text: prev ? `${prev} ${text}` : text, round });
        prev = text;
      }
      pump();
    };
    let r: ChatResult | null = null;
    try {
      r = await llm.chat({ ...req, messages, signal: ctrl.signal, onText: (t) => take(t, false) });
      take(r.text, true);
      for (;;) {
        if (busy) await busy;
        else if (queue.length && !hit) pump();
        else break;
      }
    } catch (e) {
      if (!(e instanceof LlmAborted) || !hit) throw e;
      late.push(e.cost);
    }
    if (r) cost += r.costUsd;
    const h = hit as { at: number; memory: string; sep: string } | null;
    if (!h) {
      o.show(kept + seg);
      const extra = await Promise.race([Promise.all(late), new Promise<number[]>((res) => setTimeout(() => res([]), 6000))]);
      return { text: kept + seg, costUsd: cost + extra.reduce((a, b) => a + b, 0), pauses };
    }
    pauses++;
    const soFar = (kept + seg.slice(0, h.at)).trimEnd();
    messages = [...req.messages, { role: "user", content: o.resume(soFar, h.memory) }];
    kept = soFar + h.sep;
  }
}
