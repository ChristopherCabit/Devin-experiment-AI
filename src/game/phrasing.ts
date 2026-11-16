/**
 * Spots repetition the narrator may not notice: descriptions its own narration keeps reusing,
 * and distinctive phrases that come out of more than one character's mouth.
 * A character repeating their own habit is left alone.
 */

const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from into onto over under up down out off as is are was were be been being it its it's this that these those there here he him his she her hers they them their you your yours i me my we us our not no nor do does did done have has had just like than too very can could would should will shall may might must one some any all each every what which who whom whose when where why how only own same such again still yet back away around through about after before while once more most other".split(" "),
);

const QUOTE = /["“][^"”\n]*["”]/g;
const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").match(/[a-z][a-z']*/g) ?? [];

function grams(ws: string[], n: number, nameWords: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) {
    const g = ws.slice(i, i + n);
    const content = g.filter((w) => !STOP.has(w) && !nameWords.has(w.replace(/'s$/, "")));
    if (content.length >= 2 && !STOP.has(g[0] ?? "") && !STOP.has(g[n - 1] ?? "")) out.push(g.join(" "));
  }
  return out;
}

/** Longest-first, dropping any phrase contained in one already kept. */
function distinct(ps: string[], max: number): string[] {
  const kept: string[] = [];
  for (const p of [...ps].sort((a, b) => b.length - a.length)) if (!kept.some((k) => k.includes(p))) kept.push(p);
  return kept.slice(0, max);
}

/**
 * `outputs`: recent passages, oldest first. `speakers`: character names (first word is enough) that can be attributed dialogue.
 * `nameWords`: words from names of anything tracked (people, places, objects), which don't count as phrasing.
 * `quoted`: the protagonist's recent words, which characters may fairly repeat back.
 * `present`: per passage, the names of the characters there; someone who heard a phrase may pick it up.
 */
export function phrasingNote(outputs: string[], speakers: string[], nameWords: Set<string>, quoted: string[] = [], present: string[][] = []): string {
  const theirs = new Set([3, 4].flatMap((n) => quoted.flatMap((q) => grams(words(q), n, nameWords))));
  const narr = new Map<string, number>();
  const said = new Map<string, Set<string>>();
  const heardBy = new Map<string, Set<string>>();
  outputs.forEach((text, i) => {
    const seen = new Set<string>();
    for (const n of [2, 3, 4]) for (const g of grams(words(text.replace(QUOTE, " | ")), n, nameWords)) seen.add(g);
    if (i >= outputs.length - 20) for (const g of seen) narr.set(g, (narr.get(g) ?? 0) + 1);
    for (const para of text.split(/\n+/)) {
      const quotes = para.match(QUOTE);
      if (!quotes) continue;
      const who = speakers.filter((s) => new RegExp(`\\b${s.replace(/[^\w]/g, "")}\\b`).test(para));
      const [speaker] = who;
      if (who.length !== 1 || !speaker) continue;
      for (const q of quotes)
        for (const g of [3, 4].flatMap((n) => grams(words(q), n, nameWords))) {
          const heard = heardBy.get(g);
          if (theirs.has(g) || heard?.has(speaker)) continue;
          said.set(g, (said.get(g) ?? new Set<string>()).add(speaker));
          heardBy.set(g, new Set([...(heard ?? []), ...(present[i] ?? []), speaker]));
        }
    }
  });
  // Two-word phrases ("scarred oak") need more repeats before they count as a habit.
  const habits = distinct([...narr].filter(([g, c]) => c >= (g.includes(" ", g.indexOf(" ") + 1) ? 3 : 5)).map(([g]) => g), 8);
  const shared = distinct([...said].filter(([, s]) => s.size >= 2).map(([g]) => g), 4);
  const lines: string[] = [];
  if (habits.length) lines.push(`Your narration has leaned on these lately; find a fresh way to say them unless repeating is the point: ${habits.map((h) => `"${h}"`).join(", ")}.`);
  if (shared.length)
    lines.push(
      `Said by more than one character lately: ${shared.map((g) => `"${g}" (${[...(said.get(g) ?? [])].join(", ")})`).join("; ")}. Unless one picked it up from the other, keep each character's way of speaking their own.`,
    );
  return lines.join("\n");
}
