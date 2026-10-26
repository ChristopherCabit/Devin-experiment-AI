import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import type { ChatRequest } from "../src/llm/client.js";
import { WorldStore } from "../src/world/store.js";

const isNarrator = (req: ChatRequest) => /Text inside <player> tags/.test(String(req.messages[0]?.content));
const resuming = (req: ChatRequest) => /<so_far>/.test(String(req.messages.at(-1)?.content));

/** A stand-in embedding: anything about the fox points one way, everything else somewhere of its own. */
function fakeVector(text: string): number[] {
  const v = Array<number>(64).fill(0);
  if (/\bfox\b/i.test(text.split("Query: ").at(-1) ?? text)) v[0] = 1;
  else {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[1 + (h % 63)] = 1;
  }
  return v;
}

function world(narration: (req: ChatRequest) => string) {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  store.setMeta("settings", { recentTokens: 1000, embedModel: "e" });
  const seen: ChatRequest[] = [];
  const embedded: string[] = [];
  const llm = {
    chat: (req: ChatRequest) => (seen.push(req), Promise.resolve({ text: isNarrator(req) ? narration(req) : "{}", promptTokens: 0, completionTokens: 0, costUsd: 0 })),
    embed: (_m: string, texts: string[]) => (embedded.push(...texts), Promise.resolve({ vectors: texts.map(fakeVector), costUsd: 0 })),
  };
  for (let i = 0; i < 150; i++)
    log.commit({ kind: "do", input: i === 5 ? "I give Mara a carved wooden fox" : `wait ${i}`, output: i === 5 ? "Mara takes the fox and sets it on the shelf." : `Mara wipes down the bar, turn ${i}, and the rain goes on.`, ops: [{ op: "time_advance", minutes: 20 }], source: "engine" });
  return { store, log, seen, embedded, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}

describe("memories by meaning", () => {
  it("indexes the story and brings back what the player asks about before the narrator writes", async () => {
    const { seen, embedded, deps } = world(() => "<ops></ops>Mara glances at the shelf.");
    await playTurn(deps, "say", "Mara, do you still have the fox?");
    expect(embedded.some((t) => t.includes("carved wooden fox") && !t.startsWith("Instruct"))).toBe(true);
    const user = String(seen.find(isNarrator)?.messages[1]?.content);
    expect(user.split("## Might come to mind")[1]).toContain("Mara takes the fox and sets it on the shelf.");
  });

  it("pauses partway through a passage when a sentence brings a memory back, and carries on from there", async () => {
    const { seen, log, deps } = world((req) =>
      resuming(req) ? "She sets it back where it was without a word." : "<ops></ops>The rain keeps on against the shutters tonight.\n\nMara turns the little fox over in her fingers, slowly.",
    );
    const out = await playTurn(deps, "do", "I sit by the fire and listen to the rain");
    const resume = seen.find(resuming);
    expect(String(resume?.messages.at(-1)?.content)).toContain("Mara takes the fox and sets it on the shelf.");
    expect(String(resume?.messages.at(-1)?.content)).toContain("<so_far>\n<ops></ops>The rain keeps on against the shutters tonight.\n</so_far>");
    expect(out.text).toBe("The rain keeps on against the shutters tonight.\n\nShe sets it back where it was without a word.");
    expect(log.history(1)[0]?.output).toBe(out.text);
  });
});

describe("indexing an existing save", () => {
  it("fills in the oldest turns first", async () => {
    const { log, embedded, deps } = world(() => "<ops></ops>Fine.");
    const { indexTurns, normalize } = await import("../src/game/association.js");
    await indexTurns(deps.store, log, async (texts) => ({ vectors: texts.map((t) => normalize(fakeVector(t))), costUsd: 0 }), 3);
    expect(embedded).toEqual([]);
    expect(log.history(5000).slice(1, 4).every((t) => deps.store.getMeta(`vec:${t.n}`, null))).toBe(true);
    expect(deps.store.getMeta(`vec:${log.lastTurn()}`, null)).toBeNull();
  });
});
