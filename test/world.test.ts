import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { DEFAULT_SETTINGS } from "../src/game/context.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { agingOps, newsReached, selectThreads, simulatePeriod, threadText } from "../src/game/world.js";
import type { ChatRequest } from "../src/llm/client.js";
import type { OpInput } from "../src/ops/schema.js";
import { threads, worldEvents } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

const S = DEFAULT_SETTINGS;

function world(reply: (req: ChatRequest) => string = () => "<ops></ops>Fine.") {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const calls: ChatRequest[] = [];
  const llm = {
    chat: (req: ChatRequest) => {
      calls.push(req);
      return Promise.resolve({ text: reply(req), promptTokens: 0, completionTokens: 0, costUsd: 0.001 });
    },
  };
  const author = (ops: OpInput[]) => log.commit({ kind: "author", input: "edit", ops, source: "author" });
  return { store, log, llm, calls, author, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}

describe("threads", () => {
  it("are created by op and removed by undo", () => {
    const { store, log, author } = world();
    author([{ op: "thread", title: "Forty silver", text: "Owed to the Grey Vintners", participants: ["character:rook"], deadline_hours: 24 }]);
    expect(threads(store)).toHaveLength(1);
    expect(threads(store)[0]?.deadline).toBeGreaterThan(0);
    log.undo();
    expect(threads(store)).toHaveLength(0);
  });

  it("become urgent once the deadline passes", () => {
    const { store, author } = world();
    author([{ op: "thread", title: "Debt", participants: [], deadline_hours: 2 }]);
    expect(agingOps(store)).toHaveLength(0);
    author([{ op: "time_advance", minutes: 180 }]);
    const ops = agingOps(store);
    expect(ops).toEqual([expect.objectContaining({ op: "thread_update", urgency: "urgent" })]);
    author(ops);
    expect(threads(store)[0]?.urgency).toBe("urgent");
    expect(agingOps(store)).toHaveLength(0);
  });

  it("only scene-relevant threads reach the narrator, and calm moments only admit urgent ones", () => {
    const { store, author } = world();
    author([
      { op: "thread", title: "Rook's rivalry", participants: ["character:rook"] },
      { op: "thread", title: "Far-off feud", participants: [], urgency: "urgent" },
    ]);
    expect(selectThreads(store, PLAYER_ID, "social", S).map((t) => t.title)).toEqual(["Rook's rivalry"]);
    expect(selectThreads(store, PLAYER_ID, "quiet", S)).toHaveLength(0);
    expect(selectThreads(store, PLAYER_ID, "social", { ...S, influence: "pressing" }).map((t) => t.title)).toContain("Far-off feud");
    expect(selectThreads(store, PLAYER_ID, "social", { ...S, threads: false })).toHaveLength(0);
    expect(threadText(store, selectThreads(store, PLAYER_ID, "social", S), S)).toMatch(/Ignoring all of them is normal/);
  });

  it("the after-turn review opens and resolves threads in the same undoable turn", async () => {
    const review = (req: ChatRequest) =>
      /keep the game's records/.test(String(req.messages[0]?.content))
        ? JSON.stringify({ threads: [{ title: "Rook's favour", text: "You promised to fetch his knife", participants: ["character:rook"] }] })
        : "<ops></ops>Rook nods. \"You promised, then.\"";
    const { store, log, deps } = world(review);
    await playTurn(deps, "say", "I promise I'll fetch your knife");
    expect(threads(store).map((t) => t.title)).toEqual(["Rook's favour"]);
    log.undo();
    expect(threads(store)).toHaveLength(0);
  });
});

describe("world events", () => {
  it("news travels according to reach and connectedness", () => {
    const { store, author } = world();
    author([
      { op: "world_event", text: "Plague in the capital", reach: "regional" },
      { op: "world_event", text: "Fire on the street", reach: "local", origin: "region:marrow" },
    ]);
    const [plague, fire] = worldEvents(store);
    expect(newsReached(store, fire!, "room:common", S)).toBe(true);
    expect(newsReached(store, plague!, "room:common", S)).toBe(false);
    author([{ op: "time_advance", minutes: 13 * 60 }]);
    expect(newsReached(store, plague!, "room:common", { ...S, connectedness: "global" })).toBe(true);
    expect(newsReached(store, plague!, "room:common", { ...S, connectedness: "isolated" })).toBe(false);
  });
});

describe("off-screen lives", () => {
  const period = JSON.stringify({
    npcs: [
      { id: "character:rook", where: "room:common", mood: ["sour"], event: "Lost a hand of cards to a stranger.", thought: "That stranger cheated." },
      { id: "character:mara", where: null, mood: null, event: "Argued with the brewer.", thought: null },
      { id: "character:nobody", where: null, mood: null, event: "x", thought: null },
    ],
    world_event: null,
  });

  it("one batched call; never moves anyone into the player's room; ignores unknown ids", async () => {
    const { store, llm, author, calls } = world(() => period);
    author([{ op: "move", id: "character:rook", to: "room:upstairs" }, { op: "move", id: "character:mara", to: "room:upstairs" }]);
    const { ops } = await simulatePeriod(store, llm, S, PLAYER_ID, "Rook and Mara", () => 0.99);
    expect(calls).toHaveLength(1);
    expect(ops.some((o) => o.op === "move")).toBe(false);
    expect(ops.filter((o) => o.op === "life_event")).toHaveLength(2);
    expect(ops[0]).toEqual({ op: "life_tick" });
    expect(JSON.stringify(ops)).not.toContain("character:nobody");
  });

  it("a due period runs after the turn and is applied to the next one, unless that turn was undone", async () => {
    const route = (req: ChatRequest) => (/off-screen lives/.test(String(req.messages[0]?.content)) ? period : "<ops></ops>Time passes.");
    for (const undo of [false, true]) {
      const { store, log, author, deps } = world(route);
      author([{ op: "move", id: "character:rook", to: "room:upstairs" }, { op: "time_advance", minutes: 300 }]);
      await playTurn(deps, "do", "wait at the bar");
      if (undo) log.undo();
      await playTurn(deps, "do", "wait at the bar");
      const life = store.getEntity("character:rook")?.props.life as unknown[] | undefined;
      expect(Boolean(life?.length)).toBe(!undo);
    }
  });
});
