import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { describeScene } from "../src/game/context.js";
import { CHAPTER_TURNS, chapterContext, updateChapters, validChapters } from "../src/game/memory.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { WorldStore } from "../src/world/store.js";

function world() {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  return { store, log };
}
const llm = (text: string) => ({ chat: () => Promise.resolve({ text, costUsd: 0.0001 }) });
const play = (log: TurnLog, i: number) => log.commit({ kind: "do", input: `act ${i}`, output: `Story ${i}.`, ops: [], source: "engine" });

describe("chapter memory", () => {
  it("summarises every CHAPTER_TURNS turns and drops a chapter whose turns were undone", async () => {
    const { store, log } = world();
    for (let i = 0; i < CHAPTER_TURNS - 2; i++) play(log, i);
    expect(await updateChapters(store, log, llm("Too early."), "m")).toBe(0);
    play(log, 98);
    play(log, 99);
    await updateChapters(store, log, llm("You met the innkeeper and owe her two silver."), "m");
    expect(validChapters(store, log)).toHaveLength(1);
    expect(chapterContext(store, log, log.lastTurn() + 1, [], 1000)).toContain("owe her two silver");
    expect(chapterContext(store, log, 3, [], 1000)).toBe("");
    log.undo();
    expect(validChapters(store, log)).toHaveLength(0);
    play(log, 100);
    expect(validChapters(store, log)).toHaveLength(0);
  });

  it("prefers older chapters that mention someone present when the budget is tight", () => {
    const { store, log } = world();
    for (let i = 0; i < 60; i++) play(log, i);
    const turns = new Map(log.history(100).map((t) => [t.n, t]));
    const ch = (from: number, to: number, text: string) => ({ from, to, sig: `${turns.get(to)?.created_at}|${turns.get(to)?.output.slice(0, 80)}`, text });
    store.setMeta("chapters", [ch(2, 11, "Ilse left you a guitar as a gift."), ch(12, 21, "Filler one."), ch(22, 31, "Filler two."), ch(32, 41, "Filler three."), ch(42, 51, "Filler four."), ch(52, 61, "Filler five.")]);
    const out = chapterContext(store, log, 62, ["Ilse"], 55);
    expect(out).toContain("guitar");
    expect(out).toContain("Filler five");
    expect(out).not.toContain("Filler one");
  });
});

describe("facts in the scene", () => {
  it("keeps old facts about things in the room even after many unrelated facts", () => {
    const { store } = world();
    const here = store.getEntity(PLAYER_ID)?.parent_id ?? "";
    store.addFact("The guitar was a gift.", [here], 1);
    for (let i = 0; i < 50; i++) store.addFact(`Unrelated ${i}.`, [], 2);
    expect(describeScene(store, PLAYER_ID).text).toContain("The guitar was a gift.");
  });
});

describe("prose review", () => {
  it("records facts and lasting profile details from the passage in the same undoable turn", async () => {
    const { store, log } = world();
    const review = JSON.stringify({ characters: [], details: [{ id: "character:rook", add: "a scar through his left eyebrow" }], facts: [{ text: "Rook left a guitar in your room as a gift.", subjects: ["character:rook", "character:nobody"] }] });
    const replies = ["<ops></ops>Rook touches the scar through his eyebrow. \"Left you a guitar,\" he says.", review];
    const llm = { chat: () => Promise.resolve({ text: replies.shift() ?? "{}", promptTokens: 0, completionTokens: 0, costUsd: 0 }) };
    const { playTurn } = await import("../src/game/pipeline.js");
    await playTurn({ store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 }, "do", "go to the bar");
    const rook = store.getEntity("character:rook")?.props as { appearance?: string };
    expect(rook.appearance).toContain("scar through his left eyebrow");
    expect(store.facts().at(-1)).toMatchObject({ text: "Rook left a guitar in your room as a gift.", subjects: ["character:rook"] });
    log.undo();
    expect((store.getEntity("character:rook")?.props as { appearance?: string }).appearance ?? "").not.toContain("scar");
    expect(store.facts().some((f) => f.text.includes("guitar"))).toBe(false);
  });
});
