import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { describeScene, storyWindow } from "../src/game/context.js";
import { recallPassages, turnClock } from "../src/game/memory.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { simulatePeriod } from "../src/game/world.js";
import { DEFAULT_SETTINGS } from "../src/game/context.js";
import type { ChatRequest } from "../src/llm/client.js";
import { WorldStore } from "../src/world/store.js";

function world(reply: (req: ChatRequest) => string = () => "<ops></ops>Fine.") {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const seen: ChatRequest[] = [];
  const llm = { chat: (req: ChatRequest) => (seen.push(req), Promise.resolve({ text: reply(req), promptTokens: 0, completionTokens: 0, costUsd: 0 })) };
  return { store, log, seen, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}
const turn = (log: TurnLog, input: string, output: string, minutes = 30) => log.commit({ kind: "do", input, output, ops: [{ op: "time_advance", minutes }], source: "engine" });
const filler = (i: number) => `The rain kept on outside while the fire burned low, turn ${i}.`;
const isNarrator = (req: ChatRequest) => /Text inside <player> tags/.test(String(req.messages[0]?.content));
const isReview = (req: ChatRequest) => /keep the game's records/.test(String(req.messages[0]?.content));
const section = (text: string, head: string) => text.split(head)[1]?.split("\n## ")[0] ?? "";

describe("recalling exact past passages", () => {
  it("knows the in-game time at the end of each turn", () => {
    const { store, log } = world();
    const start = store.getMeta<number>("clock_minutes", 0);
    turn(log, "a", "A.", 60);
    turn(log, "b", "B.", 90);
    const times = turnClock(log.history(10), store.getMeta<number>("clock_minutes", 0));
    expect(times.get(log.lastTurn() - 1)).toBe(start + 60);
    expect(times.get(log.lastTurn())).toBe(start + 150);
  });

  it("returns the matching old turn verbatim with its neighbours and time, and nothing for everyday words", () => {
    const { store, log } = world();
    for (let i = 0; i < 40; i++) turn(log, `wait ${i}`, i === 10 ? "Mara sells the copper lantern to a tinker for three silver." : filler(i));
    const target = log.history(100).find((t) => t.output.includes("copper lantern"));
    if (!target) throw new Error("no target");
    const out = recallPassages(store, log, log.lastTurn() - 5, "Whatever happened to that copper lantern the tinker bought?", 2000);
    expect(out).toContain("Mara sells the copper lantern to a tinker for three silver.");
    expect(out).toContain(`turns ${target.n - 1}-${target.n + 1}`);
    expect(out).toMatch(/### Day \d+, \d\d:\d\d/);
    expect(out).toContain("> You: wait 10");
    expect(recallPassages(store, log, log.lastTurn() - 5, "the rain and the fire outside", 2000)).toBe("");
    expect(recallPassages(store, log, target.n, "copper lantern tinker", 2000)).toBe("");
  });

  it("the narrator gets a capped recent window plus the recalled passage", async () => {
    const { store, log, seen, deps } = world();
    store.setMeta("settings", { recentTokens: 2000 });
    for (let i = 0; i < 120; i++) turn(log, `look around ${i}`, i === 3 ? "Rook swears on his brother's grave to repay the ferryman by midsummer." : `${filler(i)} `.repeat(6));
    await playTurn(deps, "say", "Rook, did you ever repay the ferryman?");
    const user = String(seen.find(isNarrator)?.messages[1]?.content);
    expect(section(user, "## Story so far").length / 4).toBeLessThanOrEqual(2100);
    expect(section(user, "## Recalled earlier passages")).toContain("swears on his brother's grave");
  });

  it("answers a narrator lookup from any earlier turn, even on a single word", async () => {
    const { log, seen, deps } = world();
    const asked: string[] = [];
    (deps.llm as { chat: (r: ChatRequest) => Promise<unknown> }).chat = async (r: ChatRequest) => {
      seen.push(r);
      if (r.onTool && isNarrator(r)) asked.push(await r.onTool("recall", '{"query":"Elsbeth"}'), await r.onTool("recall", '{"query":"griffin saddle"}'));
      return { text: "<ops></ops>Fine.", promptTokens: 0, completionTokens: 0, costUsd: 0 };
    };
    for (let i = 0; i < 120; i++) log.commit({ kind: "say", input: i === 3 ? "My sister Elsbeth drowned at Varrow." : `line ${i}`, output: `${filler(i)} `.repeat(8), ops: [], source: "engine" });
    await playTurn(deps, "do", "sit at the bar");
    const narr = seen.find(isNarrator);
    expect(narr?.tools?.[0]?.name).toBe("recall");
    expect(asked[0]).toContain('> You say: "My sister Elsbeth drowned at Varrow."');
    expect(asked[0]).toMatch(/### Day \d+, \d\d:\d\d \(turns/);
    expect(asked[1]).toMatch(/^Nothing earlier matches/);
    expect(String(narr?.messages[1]?.content)).not.toContain("Elsbeth");
  });

  it("labels the protagonist's lines in the story window", () => {
    const { log } = world();
    log.commit({ kind: "say", input: "The mine will save the inn.", output: "Mara shakes her head.", ops: [], source: "engine" });
    expect(storyWindow(log, 1000).text).toContain('> You say: "The mine will save the inn."\nMara shakes her head.');
  });
});

describe("opinions", () => {
  it("are recorded for characters present, replaced on a change of mind, shown in the scene, never set for the protagonist, and undone", async () => {
    let views: unknown[] = [{ id: "[character:mara]", topic: "mining the shrine", view: "against it; her mother is buried there" }, { id: PLAYER_ID, topic: "mining the shrine", view: "for it" }];
    const { store, log, deps } = world((req) => (isReview(req) ? JSON.stringify({ opinions: views }) : "<ops></ops>Mara folds her arms."));
    await playTurn(deps, "say", "The mine will save the inn.");
    expect(describeScene(store, PLAYER_ID).text).toContain("on mining the shrine: against it; her mother is buried there");
    expect(store.getEntity(PLAYER_ID)?.props.opinions).toBeUndefined();
    views = [{ id: "character:mara", topic: "Mining the shrine", view: "grudgingly for it, if the bones are moved first" }];
    await playTurn(deps, "say", "We'll move the bones first.");
    expect(store.getEntity("character:mara")?.props.opinions).toEqual({ "mining the shrine": "grudgingly for it, if the bones are moved first" });
    log.undo();
    expect(store.getEntity("character:mara")?.props.opinions).toEqual({ "mining the shrine": "against it; her mother is buried there" });
  });

  it("can change off screen, with the reason kept", async () => {
    const { store, log } = world();
    log.commit({ kind: "author", input: "edit", ops: [{ op: "move", id: "character:rook", to: "room:upstairs" }], source: "author" });
    const period = JSON.stringify({ npcs: [{ id: "character:rook", where: null, mood: null, event: null, thought: null, opinion: { topic: "the new toll", view: "wants it gone", why: "a carter told him it doubled" } }], world_event: null });
    const llm = { chat: () => Promise.resolve({ text: period, promptTokens: 0, completionTokens: 0, costUsd: 0 }) };
    store.setMeta("life_tick", -1000);
    const { ops } = await simulatePeriod(store, llm, DEFAULT_SETTINGS, PLAYER_ID, "Rook", () => 0.99);
    expect(ops).toContainEqual({ op: "opinion", id: "character:rook", topic: "the new toll", view: "wants it gone", why: "a carter told him it doubled" });
  });
});
