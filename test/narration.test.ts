import { describe, expect, it } from "vitest";
import { seedWorld } from "../src/app/game.js";
import { TurnLog } from "../src/engine/turns.js";
import { DEFAULT_SETTINGS, recentStory } from "../src/game/context.js";
import { limitThoughts, thoughtBudgets, untrackedNames } from "../src/game/pipeline.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { applyOp } from "../src/ops/apply.js";
import { WorldStore } from "../src/world/store.js";

function world() {
  const store = new WorldStore();
  const log = new TurnLog(store);
  seedWorld(store, log);
  return { store, log };
}
const narrator = { source: "narrator" as const, turn: 3 };

describe("narration fixes", () => {
  it("the opening paragraph stays in the narrator's story, including after undoing back to it", () => {
    const { log } = world();
    expect(recentStory(log, 5000)).toContain(STARTER.opening.slice(0, 40));
    log.commit({ kind: "do", input: "I open the door", output: "It creaks.", ops: [], source: "engine" });
    log.undo();
    expect(recentStory(log, 5000)).toContain(STARTER.opening.slice(0, 40));
  });

  it("the narrator renames a designated NPC, keeping the designator as an alias, but never the player", () => {
    const { store } = world();
    expect(applyOp(store, { op: "rename", id: "character:rook", name: "Garrick Vane" }, narrator).ok).toBe(true);
    expect(store.getEntity("character:rook")).toMatchObject({ name: "Garrick Vane", aliases: expect.arrayContaining(["Rook"]) });
    expect(applyOp(store, { op: "rename", id: PLAYER_ID, name: "Bob" }, narrator).ok).toBe(false);
  });

  it("thought budgets favour engaged and major characters and are enforced", () => {
    const { store } = world();
    const rook = store.getEntity("character:rook")!;
    const mara = store.getEntity("character:mara")!;
    const crowd = { ...mara, id: "character:crowd", name: "Drinkers", aliases: [], props: { ...mara.props, group: { count: 6 } } };
    const s = { ...DEFAULT_SETTINGS, thoughtsPerTurn: 4 };
    const b = thoughtBudgets([rook, mara, crowd], s, "I ask Rook about the ledger");
    expect(b.map((x) => x.max)).toEqual([4, 2, 1]);
    const t = (npc: string, key: string) => ({ op: "thought", npc, key, text: "hm" });
    const kept = limitThoughts([t("character:mara", "a"), t("character:mara", "b"), t("character:mara", "c"), { op: "emotion", npc: "character:mara", set: [] }], b);
    expect(kept).toHaveLength(3);
    expect(thoughtBudgets([mara], { ...s, thoughtsPerTurn: 0 }, "").map((x) => x.max)).toEqual([0]);
  });

  it("finds named characters the narrator mentioned but never created", () => {
    const { store } = world();
    expect(untrackedNames(store, "The door opens and Liesl steps in, nodding to Rook. Rain falls.", [])).toEqual(["Liesl"]);
    expect(untrackedNames(store, "and Liesl waves.", [{ op: "create_entity", name: "Liesl" }])).toEqual([]);
  });

  it("undo reverts everything the narrator changed that turn", () => {
    const { store, log } = world();
    log.commit({
      kind: "do", input: "x", output: "y",
      batches: [{ source: "narrator", ops: [
        { op: "create_entity", id: "character:liesl", kind: "character", name: "Liesl", parent: store.getEntity(PLAYER_ID)?.parent_id ?? null, props: { age: 30 } },
        { op: "rename", id: "character:rook", name: "Garrick" },
        { op: "thought", npc: "character:mara", key: "k", text: "Hm." },
      ] }],
    });
    expect(store.getEntity("character:liesl")).toBeTruthy();
    log.undo();
    expect(store.getEntity("character:liesl")).toBeFalsy();
    expect(store.getEntity("character:rook")?.name).toBe("Rook");
    expect(JSON.stringify(store.getEntity("character:mara")?.props)).not.toContain('"k"');
  });
});
