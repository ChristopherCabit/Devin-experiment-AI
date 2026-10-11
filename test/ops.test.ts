import { describe, expect, it } from "vitest";
import { applyOp, type ApplyContext } from "../src/ops/apply.js";
import { charProps, clockMinutes, itemProps } from "../src/world/queries.js";
import { PLAYER, makeWorld, snapshot } from "./fixtures.js";

const narrator: ApplyContext = { source: "narrator", turn: 2 };
const engine: ApplyContext = { source: "engine", turn: 2 };
const author: ApplyContext = { source: "author", turn: 2 };

function setup() {
  const { store } = makeWorld();
  const run = (op: unknown, ctx: ApplyContext = narrator) => applyOp(store, op, ctx);
  const player = () => charProps(store.getEntity(PLAYER)!);
  return { store, run, player };
}

describe("schema and containment", () => {
  it("rejects malformed ops with a reason", () => {
    const { run } = setup();
    const r = run({ op: "move", id: PLAYER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid op/);
    expect(run({ op: "teleport", id: PLAYER }).ok).toBe(false);
  });

  it("enforces which kinds may contain which", () => {
    const { run } = setup();
    expect(run({ op: "create_entity", kind: "room", name: "Attic", parent: "region:town" })).toMatchObject({
      ok: false,
      reason: "a room can't be inside a region",
    });
    expect(run({ op: "create_entity", kind: "character", name: "Ghost" })).toMatchObject({ ok: false });
  });

  it("prevents containment cycles", () => {
    const { run } = setup();
    expect(run({ op: "move", id: "container:chest", to: "item:ring" }, author)).toMatchObject({
      ok: false,
      reason: "containment cycle",
    });
  });

  it("only lets author mode move locations", () => {
    const { run } = setup();
    expect(run({ op: "move", id: "room:kitchen", to: "place:bakery" }).ok).toBe(false);
    expect(run({ op: "move", id: "room:kitchen", to: "place:bakery" }, author).ok).toBe(true);
  });

  it("lazily creates new things under the right parent, with zones on demand", () => {
    const { store, run } = setup();
    const r = run({ op: "create_entity", kind: "container", name: "drawer", parent: "room:bedroom", zone: "Under Bed" });
    expect(r).toMatchObject({ ok: true, id: "container:drawer" });
    expect(itemProps(store.getEntity("container:drawer")!).zone).toBe("under bed");
    expect(store.getEntity("room:bedroom")!.props.zones).toContain("under bed");
    expect(run({ op: "create_entity", kind: "container", name: "drawer", parent: "room:bedroom" })).toMatchObject({
      id: "container:drawer-2",
    });
  });

  it("leaves no partial state when an op fails", () => {
    const { store, run } = setup();
    const before = snapshot(store);
    expect(run({ op: "create_entity", kind: "character", name: "Bad", parent: "room:bedroom", props: { age: "x" } }).ok).toBe(false);
    expect(snapshot(store)).toBe(before);
  });
});

describe("hands, reach and possession", () => {
  it("holds carried items and respects reach, closed containers and other carriers", () => {
    const { run, player } = setup();
    expect(run({ op: "hold", character: PLAYER, item: "item:apple" }).ok).toBe(true);
    expect(player().scene.hands.right).toBe("item:apple");
    expect(run({ op: "hold", character: PLAYER, item: "item:coat" })).toMatchObject({ reason: "coat is out of reach" });
    expect(run({ op: "hold", character: PLAYER, item: "item:keys" })).toMatchObject({ reason: "keys is carried by Mara" });
    expect(run({ op: "set_zone", id: PLAYER, zone: "bed" }).ok).toBe(true);
    expect(run({ op: "hold", character: PLAYER, item: "item:ring" })).toMatchObject({ reason: "ring is out of reach" });
    expect(run({ op: "hold", character: PLAYER, item: "item:coat" }).ok).toBe(true);
    expect(player().scene.hands.left).toBe("item:coat");
    expect(run({ op: "hold", character: PLAYER, item: "container:chest" })).toMatchObject({ reason: "both hands are full" });
  });

  it("can't reach other rooms", () => {
    const { run } = setup();
    expect(run({ op: "hold", character: PLAYER, item: "item:knife" })).toMatchObject({ ok: false });
  });

  it("wears and unwears into slots", () => {
    const { store, run, player } = setup();
    run({ op: "set_zone", id: PLAYER, zone: "window" });
    run({ op: "hold", character: PLAYER, item: "item:coat" });
    expect(run({ op: "wear", character: PLAYER, item: "item:coat" }).ok).toBe(true);
    expect(player().scene.worn.torso).toBe("item:coat");
    expect(player().scene.hands.right).toBeNull();
    expect(run({ op: "give", from: PLAYER, to: "character:mara", item: "item:coat" })).toMatchObject({ ok: false });
    expect(run({ op: "unwear", character: PLAYER, slot: "torso" }).ok).toBe(true);
    expect(store.getEntity("item:coat")!.parent_id).toBe(PLAYER);
    expect(run({ op: "wear", character: PLAYER, item: "item:apple" })).toMatchObject({ reason: "apple has no worn slot" });
  });

  it("gives only within reach and clears hands", () => {
    const { store, run, player } = setup();
    run({ op: "hold", character: PLAYER, item: "item:apple" });
    expect(run({ op: "give", from: PLAYER, to: "character:mara", item: "item:apple" })).toMatchObject({
      reason: "Mara is out of reach",
    });
    run({ op: "set_zone", id: PLAYER, zone: "bed" });
    expect(run({ op: "give", from: PLAYER, to: "character:mara", item: "item:apple" }).ok).toBe(true);
    expect(store.getEntity("item:apple")!.parent_id).toBe("character:mara");
    expect(player().scene.hands.right).toBeNull();
  });

  it("drops items where the character stands", () => {
    const { store, run } = setup();
    run({ op: "hold", character: PLAYER, item: "item:apple" });
    expect(run({ op: "release", character: PLAYER, item: "item:apple", drop: true }).ok).toBe(true);
    const apple = store.getEntity("item:apple")!;
    expect(apple.parent_id).toBe("room:bedroom");
    expect(itemProps(apple).zone).toBe("door");
  });

  it("moves carried items along with their carrier", () => {
    const { store, run } = setup();
    expect(run({ op: "move", id: "character:mara", to: "room:kitchen" }).ok).toBe(true);
    expect(store.getEntity("item:keys")!.parent_id).toBe("character:mara");
    expect(run({ op: "hold", character: PLAYER, item: "item:keys" }).ok).toBe(false);
  });
});

describe("authority boundaries", () => {
  it("keeps resource and progression changes engine-only", () => {
    const { run, player } = setup();
    expect(run({ op: "progression", character: PLAYER, path: "power_tier", to: 10 })).toMatchObject({
      reason: "progression is engine-only",
    });
    expect(run({ op: "resource_delta", character: PLAYER, resource: "hp", delta: 5 }).ok).toBe(false);
    expect(run({ op: "progression", character: PLAYER, path: "skills", key: "swordsmanship", to: 4 }, engine).ok).toBe(true);
    expect(player().sheet.skills.swordsmanship).toBe(4);
  });

  it("clamps resources to their bounds", () => {
    const { run, player } = setup();
    run({ op: "resource_delta", character: PLAYER, resource: "hp", delta: -15 }, engine);
    expect(player().sheet.resources.hp?.value).toBe(0);
    expect(run({ op: "resource_delta", character: PLAYER, resource: "mana", delta: 1 }, engine).ok).toBe(false);
  });

  it("does not let the narrator write the player's mind or create players", () => {
    const { run } = setup();
    expect(run({ op: "emotion", npc: PLAYER, set: ["terrified"] }).ok).toBe(false);
    expect(run({ op: "thought", npc: PLAYER, key: "obey", text: "I must obey." }).ok).toBe(false);
    expect(
      run({ op: "create_entity", kind: "character", name: "Alt", parent: "room:bedroom", props: { is_player: true } }).ok,
    ).toBe(false);
  });

  it("lets the narrator injure the player but not heal conditions", () => {
    const { store, run } = setup();
    expect(run({ op: "set_condition", id: PLAYER, add: ["broken arm"] }).ok).toBe(true);
    expect(run({ op: "set_condition", id: PLAYER, remove: ["broken arm"] }).ok).toBe(false);
    expect(store.getEntity(PLAYER)!.props.conditions).toEqual(["broken arm"]);
  });

  it("clamps narrator time jumps", () => {
    const { store, run } = setup();
    expect(run({ op: "time_advance", minutes: 600 })).toMatchObject({ ok: true, note: "clamped to 240 minutes" });
    expect(clockMinutes(store)).toBe(240);
    run({ op: "time_advance", minutes: 600 }, engine);
    expect(clockMinutes(store)).toBe(840);
  });
});

describe("NPC minds", () => {
  it("stores conflicting emotions and caps brain size", () => {
    const { store, run } = setup();
    const mara = () => charProps(store.getEntity("character:mara")!);
    expect(run({ op: "emotion", npc: "character:mara", set: ["furious", "aroused", "furious"] }).ok).toBe(true);
    expect(mara().mind.emotions).toEqual(["furious", "aroused"]);
    const ctx = { ...narrator, limits: { maxThoughts: 2 } };
    expect(run({ op: "thought", npc: "character:mara", key: "a", text: "One." }, ctx).ok).toBe(true);
    expect(run({ op: "thought", npc: "character:mara", key: "b", text: "Two." }, ctx).ok).toBe(true);
    expect(run({ op: "thought", npc: "character:mara", key: "c", text: "Three." }, ctx).ok).toBe(false);
    expect(run({ op: "thought", npc: "character:mara", key: "a", text: "One, revised." }, ctx).ok).toBe(true);
    expect(run({ op: "forget_thought", npc: "character:mara", key: "b" }).ok).toBe(true);
    expect(mara().mind.thoughts).toEqual({ a: "One, revised." });
    expect(
      run({ op: "relationship_note", npc: "character:mara", target: PLAYER, text: "Resents you; can't stop watching you." }).ok,
    ).toBe(true);
  });

  it("records facts only about existing subjects", () => {
    const { store, run } = setup();
    expect(run({ op: "fact", text: "Mara owns the chest.", subjects: ["character:mara", "container:chest"] })).toMatchObject({
      ok: true,
      id: "fact:1",
    });
    expect(run({ op: "fact", text: "Ghost.", subjects: ["character:nobody"] }).ok).toBe(false);
    expect(store.facts()).toHaveLength(1);
  });
});
