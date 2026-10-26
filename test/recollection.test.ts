import { describe, expect, it } from "vitest";
import { TurnLog, type TurnRecord } from "../src/engine/turns.js";
import { turnClock } from "../src/game/memory.js";
import { lookup, playTurn } from "../src/game/pipeline.js";
import { memoryOf, recordMemory, strength, surfaceMemory, type MemoryIndex } from "../src/game/recollection.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import type { ChatRequest } from "../src/llm/client.js";
import { WorldStore } from "../src/world/store.js";

const DAY = 1440;
const filler = (i: number) => `The rain kept on outside while the fire burned low, turn ${i}.`;
const isNarrator = (req: ChatRequest) => /Text inside <player> tags/.test(String(req.messages[0]?.content));
const isReview = (req: ChatRequest) => /keep the game's records/.test(String(req.messages[0]?.content));

function world() {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  log.commit({
    kind: "author",
    input: "extras",
    source: "author",
    ops: [
      { op: "create_entity", id: "character:elsbeth", kind: "character", name: "Elsbeth", parent: "room:street", props: { description: "Your sister." } },
      { op: "create_entity", id: "character:tam", kind: "character", name: "Tam", parent: "room:street", props: { description: "A carter." } },
      { op: "create_entity", id: "item:fox", kind: "item", name: "carved fox", aliases: ["fox"], parent: "room:common" },
    ],
  });
  return { store, log };
}
const last = (log: TurnLog) => log.history(1)[0] as TurnRecord;
function play(store: WorldStore, log: TurnLog, input: string, output: string, witnesses: string[], s = 1, minutes = 30) {
  log.commit({ kind: "do", input, output, ops: [{ op: "time_advance", minutes }], source: "engine" });
  recordMemory(store, PLAYER_ID, last(log), witnesses, s);
  return last(log);
}

describe("character memories", () => {
  it("are what they were there for, with links to people, places and objects", () => {
    const { store, log } = world();
    const t = play(store, log, "show Mara the fox", "You set the carved fox on the bar. \"Elsbeth carved it,\" you tell Mara.", ["character:mara"], 2);
    const idx = memoryOf(store, PLAYER_ID, t);
    expect(idx).toMatchObject({ w: ["character:mara"], s: 2 });
    expect(idx.e).toEqual(expect.arrayContaining(["character:mara", "character:elsbeth", "item:fox", "room:common"]));
    log.undo();
    log.commit({ kind: "do", input: "x", output: "Something else.", ops: [], source: "engine" });
    expect(memoryOf(store, PLAYER_ID, last(log)).s).toBe(1);
  });

  it("keep almost anything from yesterday, then fade by significance; recalling refreshes them", () => {
    const base: MemoryIndex = { at: 0, w: [], e: [], s: 0 };
    expect(strength(base, 0, DAY)).toBe(1);
    expect(strength(base, 0, 30 * DAY)).toBeLessThan(0.1);
    expect(strength({ ...base, s: 2 }, 0, 30 * DAY)).toBeGreaterThan(0.5);
    expect(strength({ ...base, s: 3 }, 0, 3000 * DAY)).toBeGreaterThanOrEqual(0.7);
    expect(strength({ ...base, s: 1, m: ["character:mara"] }, 0, 40 * DAY, "character:mara")).toBeGreaterThan(strength({ ...base, s: 1 }, 0, 40 * DAY, "character:mara"));
    expect(strength({ ...base, r: 29 * DAY }, 0, 30 * DAY)).toBeGreaterThan(0.8);
  });

  it("a lookup as a character finds only their own memories, says how clearly, and follows one link", () => {
    const { store, log } = world();
    play(store, log, "talk to Tam", "On the street, Tam tells you Elsbeth carved that fox for the spring fair.", ["character:tam"], 2);
    for (let i = 0; i < 10; i++) play(store, log, `wait ${i}`, filler(i), ["character:mara"], 0, 60);
    play(store, log, "show Mara the fox", "You set the carved fox on the bar. Mara turns it over. \"Fine work.\"", ["character:mara"], 2);
    for (let i = 0; i < 30; i++) play(store, log, `wait more ${i}`, filler(i + 10), ["character:mara"], 0, 60);
    const before = log.lastTurn() - 5;
    const mara = lookup(store, log, before, "recall", '{"query":"carved fox","who":"Mara"}', PLAYER_ID);
    expect(mara).toContain("Mara turns it over");
    expect(mara).toMatch(/Mara remembers/);
    expect(mara).not.toContain("Tam tells you");
    const tam = lookup(store, log, before, "recall", '{"query":"fox bar","who":"Tam"}', PLAYER_ID);
    expect(tam).toMatch(/^Tam wasn't there/);
    const you = lookup(store, log, before, "recall", '{"query":"fox bar Mara"}', PLAYER_ID);
    expect(you).toContain("Mara turns it over");
    expect(you).toMatch(/### Linked memory \(also involves [^)]*carved fox/);
  });

  it("come up on their own sometimes, from what's in the scene, and not the same one every time", () => {
    const { store, log } = world();
    const fox = play(store, log, "give Mara the fox", "You press the carved fox into Mara's hand. \"Elsbeth made it. Keep it.\" Mara's eyes shine.", ["character:mara"], 3);
    for (let i = 0; i < 40; i++) play(store, log, `wait ${i}`, filler(i), ["character:mara"], 0, 60);
    const mara = store.getEntity("character:mara");
    if (!mara) throw new Error("no mara");
    const go = (r: number) =>
      surfaceMemory(store, log, { playerId: PLAYER_ID, before: log.lastTurn() - 5, present: [mara], cues: ["item:fox", "room:common", "character:mara"], times: turnClock(log.history(100), store.getMeta("clock_minutes", 0)), now: store.getMeta("clock_minutes", 0), rng: () => r, budgetTokens: 600 });
    expect(go(0.99)).toBeNull();
    const first = go(0.01);
    expect(first?.text).toMatch(/^Mara, stirred by carved fox/);
    expect(first?.turns.map((t) => t.n)).toContain(fox.n);
    expect(go(0.01)?.turns.at(-1)?.n ?? null).not.toBe(fox.n);
  });

  it("are recorded each turn with who was there and the record-keeper's significance, and surface to the narrator", async () => {
    const { store, log } = world();
    const seen: ChatRequest[] = [];
    const llm = {
      chat: (req: ChatRequest) => {
        seen.push(req);
        const text = isReview(req) ? '{"memory":{"significance":3,"moving_for":["[character:mara]"]}}' : "<ops></ops>Mara sets the carved fox back on the shelf, very carefully.";
        return Promise.resolve({ text, promptTokens: 0, completionTokens: 0, costUsd: 0 });
      },
    };
    const deps = { store, log, llm, playerId: PLAYER_ID, rng: () => 0.01 };
    await playTurn(deps, "do", "hand Mara the fox Elsbeth carved");
    const idx = memoryOf(store, PLAYER_ID, last(log));
    expect(idx.s).toBe(3);
    expect(idx.m).toEqual(["character:mara"]);
    expect(idx.w).toContain("character:mara");
    store.setMeta("settings", { recentTokens: 2000 });
    for (let i = 0; i < 80; i++) play(store, log, `wait ${i}`, `${filler(i)} `.repeat(6), ["character:mara"], 0, 60);
    seen.length = 0;
    await playTurn(deps, "do", "sit by the hearth");
    const user = String(seen.find(isNarrator)?.messages[1]?.content);
    expect(user).toContain("## Might come to mind");
    expect(user).toContain("Mara sets the carved fox back on the shelf");
  });
});

describe("pseudo tool-call markup in narration", () => {
  it("is recovered as ops and never shown", async () => {
    const { splitNarration, visibleProse } = await import("../src/game/pipeline.js");
    const raw = [
      '<parameter name="emotion">{"npc":"character:mara","set":["curious"]}</parameter>',
      'set_posture" id="character:you" posture="sitting at the hearth"</arg_value>',
      "Mara looks up from the bar.",
    ].join("\n");
    const out = splitNarration(raw);
    expect(out.prose).toBe("Mara looks up from the bar.");
    expect(out.ops).toEqual([
      { op: "emotion", npc: "character:mara", set: ["curious"] },
      { op: "set_posture", id: "character:you", posture: "sitting at the hearth" },
    ]);
    expect(visibleProse('Mara nods.\n<tool_call>emotion<arg_key>npc</arg_key><arg_value>character:ma')).toBe("Mara nods.");
  });

  it("a reply with no passage is asked for again", async () => {
    const { store, log } = world();
    const replies = ['set_posture" id="character:you" posture="sitting"</arg_value>', "<ops></ops>You settle by the fire and let the warmth find your hands."];
    let narr = 0;
    const llm = { chat: (req: ChatRequest) => Promise.resolve({ text: isNarrator(req) ? (replies[narr++] ?? "") : "{}", promptTokens: 0, completionTokens: 0, costUsd: 0 }) };
    const res = await playTurn({ store, log, llm, playerId: PLAYER_ID, rng: () => 0.9 }, "do", "sit by the fire");
    expect(narr).toBe(2);
    expect(res.text).toBe("You settle by the fire and let the warmth find your hands.");
  });
});
