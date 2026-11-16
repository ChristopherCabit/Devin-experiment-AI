import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { describeScene } from "../src/game/context.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { SyncResult, syncOps, syncRecords, syncState } from "../src/game/sync.js";
import { charProps } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

function world() {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const you = store.getEntity(PLAYER_ID)!;
  const p = charProps(you);
  p.sheet.resources.coin = { value: 9, min: 0, max: 1000000 };
  store.putEntity({ ...you, props: p });
  return { store, log };
}
const reply = (o: unknown) => ({ chat: () => Promise.resolve({ text: JSON.stringify(o), promptTokens: 0, completionTokens: 0, costUsd: 0.001 }) });

describe("state sync", () => {
  it("brings position, posture, hands, coin and time in line with the passage, undone as one turn", async () => {
    const { store, log } = world();
    const turn = log.commit({ kind: "do", input: "pay", output: "You pay.", ops: [], source: "engine" }).turn;
    const clock = store.getMeta<number>("clock_minutes", 0);
    const r = await syncState(
      reply({
        minutes: 20,
        people: [{ id: "character:mara", room: "room:upstairs", posture: "sitting on the bed", holding: ["new: lantern"] }],
        coins: [{ id: PLAYER_ID, change: -6, why: "stew and beer" }],
      }),
      store, PLAYER_ID, { ...(await import("../src/game/context.js")).DEFAULT_SETTINGS }, "pay", "You pay six coppers. Mara takes a lantern upstairs and sits on the bed.", 5,
    );
    log.amend(turn, [{ source: "engine", ops: r.ops }]);
    const mara = store.getEntity("character:mara")!;
    expect(mara.parent_id).toBe("room:upstairs");
    expect(charProps(mara).scene.posture).toBe("sitting on the bed");
    expect(store.getEntity(charProps(mara).scene.hands.right ?? "")?.name).toBe("lantern");
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.resources.coin?.value).toBe(3);
    expect(store.getMeta<number>("clock_minutes", 0) - clock).toBe(15);
    log.undo();
    expect(store.getEntity("character:mara")!.parent_id).not.toBe("room:upstairs");
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.resources.coin?.value).toBe(9);
  });

  it("flags payments the purse can't cover instead of applying them", () => {
    const { store } = world();
    const { people, places } = syncRecords(store, PLAYER_ID);
    const notes: string[] = [];
    const ops = syncOps(store, PLAYER_ID, SyncResult.parse({ coins: [{ id: PLAYER_ID, now: 12 }, { id: PLAYER_ID, change: -40 }] }), 0, people, places, notes);
    expect(ops).toEqual([{ op: "resource_delta", character: PLAYER_ID, resource: "coin", delta: 3 }]);
    expect(notes[0]).toMatch(/can't pay 40/);
  });

  it("replaces an outdated detail instead of keeping both, and the narrator sees only the current one", () => {
    const { store, log } = world();
    log.commit({ kind: "do", input: "x", ops: [{ op: "fact", text: "Stew at the Lantern costs 2 coppers.", kind: "price", subjects: ["character:mara"] }], source: "narrator" });
    const old = store.facts().at(-1)!;
    const { people, places } = syncRecords(store, PLAYER_ID);
    expect(syncRecords(store, PLAYER_ID).text).toContain(`#${old.id}, price`);
    const ops = syncOps(store, PLAYER_ID, SyncResult.parse({ details: [{ text: "Mara raised the stew to 3 coppers.", kind: "price", subjects: ["character:mara"], replaces: old.id }] }), 0, people, places);
    log.commit({ kind: "do", input: "y", ops, source: "engine" });
    expect(store.facts().find((f) => f.id === old.id)?.replaced_by).not.toBeNull();
    const scene = describeScene(store, PLAYER_ID).text;
    expect(scene).toContain("3 coppers");
    expect(scene).not.toContain("costs 2 coppers");
  });

  it("opens earshot between separate rooms without merging them", () => {
    const { store, log } = world();
    const { people, places } = syncRecords(store, PLAYER_ID);
    const ops = syncOps(store, PLAYER_ID, SyncResult.parse({ earshot: [{ a: "room:common", b: "room:upstairs", open: true }] }), 0, people, places);
    log.commit({ kind: "do", input: "z", ops, source: "engine" });
    expect(store.getEntity("room:common")!.props).toMatchObject({ open_to: ["room:upstairs"] });
    expect(store.getEntity("room:upstairs")!.props).toMatchObject({ open_to: ["room:common"] });
    expect(syncOps(store, PLAYER_ID, SyncResult.parse({ earshot: [{ a: "room:common", b: "room:upstairs", open: true }] }), 0, people, places)).toEqual([]);
  });

  it("reuses an item already there instead of creating a duplicate", () => {
    const { store } = world();
    const { people, places } = syncRecords(store, PLAYER_ID);
    const ops = syncOps(store, PLAYER_ID, SyncResult.parse({ people: [{ id: PLAYER_ID, holding: ["new: Room Key"] }] }), 0, people, places);
    expect(ops.some((o) => o.op === "create_entity")).toBe(false);
    expect(ops).toContainEqual({ op: "hold", character: PLAYER_ID, item: "item:key" });
  });
});
