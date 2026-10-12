import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { WorldStore } from "../src/world/store.js";
import { PLAYER, makeWorld, snapshot } from "./fixtures.js";

describe("TurnLog", () => {
  it("undo restores the exact prior state", () => {
    const { store, log } = makeWorld();
    const before = snapshot(store);
    const { turn, results } = log.commit({
      kind: "do",
      input: "I grab Mara's keys",
      source: "narrator",
      ops: [
        { op: "move", id: "character:mara", to: "room:kitchen", zone: "stove" },
        { op: "emotion", npc: "character:mara", set: ["angry", "amused"] },
        { op: "create_entity", kind: "item", name: "note", parent: "room:bedroom" },
        { op: "fact", text: "Mara left in a hurry.", subjects: ["character:mara"] },
        { op: "time_advance", minutes: 30 },
        { op: "progression", character: PLAYER, path: "power_tier", to: 10 },
      ],
    });
    expect(turn).toBe(2);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, false]);
    expect(snapshot(store)).not.toBe(before);
    const undone = log.undo();
    expect(undone?.n).toBe(2);
    expect(snapshot(store)).toBe(before);
    expect(log.lastTurn()).toBe(1);
  });

  it("records rejected ops without state changes", () => {
    const { log } = makeWorld();
    log.commit({ kind: "do", input: "x", source: "narrator", ops: [{ op: "hold", character: PLAYER, item: "item:keys" }] });
    const [, last] = log.history();
    expect(last?.results).toEqual([{ op: "hold", ok: false, reason: "keys is carried by Mara" }]);
    expect(last?.changes).toEqual([]);
  });

  it("retry undoes and hands back the input; turn numbers are reused", () => {
    const { log } = makeWorld();
    log.commit({ kind: "say", input: "Hello?", source: "narrator", ops: [{ op: "time_advance", minutes: 1 }] });
    expect(log.retry()).toEqual({ kind: "say", input: "Hello?", source: "narrator" });
    expect(log.commit({ kind: "say", input: "Hello?", source: "narrator", ops: [] }).turn).toBe(2);
  });

  it("undoes all the way back to an empty world", () => {
    const { store, log } = makeWorld();
    log.commit({ kind: "do", input: "wait", source: "engine", ops: [{ op: "time_advance", minutes: 5 }] });
    expect(log.undo()).not.toBeNull();
    expect(log.undo()).not.toBeNull();
    expect(log.undo()).toBeNull();
    expect(store.allEntities()).toEqual([]);
  });

  it("persists across reopen", () => {
    const a = new WorldStore();
    new TurnLog(a).commit({
      kind: "author",
      input: "setup",
      source: "author",
      ops: [{ op: "create_entity", id: "region:x", kind: "region", name: "X" }],
    });
    const bytes = a.serialize();
    a.close();
    const b = new WorldStore(bytes);
    expect(b.getEntity("region:x")?.name).toBe("X");
    expect(new TurnLog(b).undo()?.input).toBe("setup");
    expect(b.getEntity("region:x")).toBeNull();
    b.close();
  });
});
