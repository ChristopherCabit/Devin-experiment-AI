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

describe("check & fix", () => {
  it("swaps only exact, unique quotes", async () => {
    const { applyFixes } = await import("../src/game/check.js");
    const r = applyFixes("You pay six coppers. Six is a lot.", [
      { quote: "six coppers", replacement: "two coppers", why: "stew is 2" },
      { quote: "missing", replacement: "x", why: "" },
    ]);
    expect(r.text).toBe("You pay two coppers. Six is a lot.");
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });

  it("re-checking takes back the earlier sync, fixes the text and re-syncs within the same turn", async () => {
    const { store, log } = world();
    const { settleTurn } = await import("../src/game/check.js");
    const { DEFAULT_SETTINGS } = await import("../src/game/context.js");
    const turn = log.commit({ kind: "do", input: "pay", output: "You pay eight coppers for the stew.", ops: [], source: "engine" }).turn;
    const replies = [
      { coins: [{ id: PLAYER_ID, change: -8 }] },
      { fixes: [{ quote: "eight coppers", replacement: "two coppers", why: "stew costs 2" }] },
      { coins: [{ id: PLAYER_ID, change: -2 }] },
    ];
    const llm = { chat: () => Promise.resolve({ text: JSON.stringify(replies.shift()), promptTokens: 0, completionTokens: 0, costUsd: 0.001 }) };
    const deps = { store, log, llm, playerId: PLAYER_ID };
    await settleTurn(deps, DEFAULT_SETTINGS, turn, { check: false });
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.resources.coin?.value).toBe(1);
    const r = await settleTurn(deps, DEFAULT_SETTINGS, turn, { check: true });
    expect(r.text).toBe("You pay two coppers for the stew.");
    expect(log.history(1)[0]?.output).toBe(r.text);
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.resources.coin?.value).toBe(7);
    log.undo();
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.resources.coin?.value).toBe(9);
  });
});

describe("travel to a spot", () => {
  it("'the bar' sets your spot in the Common Room instead of creating a room", async () => {
    const { store } = world();
    const { travelOps } = await import("../src/game/pipeline.js");
    const you = store.getEntity(PLAYER_ID)!;
    store.putEntity({ ...you, parent_id: "room:common" });
    const r = travelOps(store, PLAYER_ID, "the bar", "same_building");
    expect(r?.ops[0]).toEqual({ op: "set_zone", id: PLAYER_ID, zone: "bar" });
    expect(r?.ops.some((o) => o.op === "create_entity")).toBe(false);
  });
});

describe("sync id cleanup and prose leaks", () => {
  it("coins reported for 'you' land on the player", async () => {
    const { store } = world();
    const { syncOps, SyncResult } = await import("../src/game/sync.js");
    const r = SyncResult.parse({ minutes: 1, coins: [{ id: "you", change: -1, why: "ale" }] });
    const ops = syncOps(store, PLAYER_ID, r, 0, [store.getEntity(PLAYER_ID)!], []);
    expect(JSON.stringify(ops)).toContain(PLAYER_ID);
    expect(ops.some((o) => o.op === "resource_delta")).toBe(true);
  });
  it("strips inline and half-tagged ops from the passage", async () => {
    const { splitNarration } = await import("../src/game/pipeline.js");
    const a = splitNarration('{"op":"time_advance","minutes":150}The knock came to nothing.');
    expect(a.prose).toBe("The knock came to nothing.");
    expect(a.ops).toHaveLength(1);
    const b = splitNarration('<op":"thought","npc":"character:tamsin","key":"name","text":"He dodged the name."  Tamsin picks the hoof pick up.');
    expect(b.prose).toBe("Tamsin picks the hoof pick up.");
  });
});
