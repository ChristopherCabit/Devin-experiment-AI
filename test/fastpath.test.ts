import { describe, expect, it } from "vitest";
import { fastPath, normalizeName } from "../src/parser/fastpath.js";
import { charProps } from "../src/world/queries.js";
import { PLAYER, makeWorld } from "./fixtures.js";

function setup() {
  const { store, log } = makeWorld();
  const parse = (input: string) => fastPath(store, PLAYER, input);
  const play = (input: string) => {
    const r = parse(input);
    if (r?.kind !== "ops") throw new Error(`expected ops for "${input}", got ${JSON.stringify(r)}`);
    const { results } = log.commit({ kind: "do", input, ops: r.ops, source: "engine" });
    expect(results.every((x) => x.ok)).toBe(true);
    return r;
  };
  const player = () => charProps(store.getEntity(PLAYER)!);
  return { store, log, parse, play, player };
}

describe("fastPath", () => {
  it("normalizes names", () => {
    expect(normalizeName("  The  Kitchen Knife. ")).toBe("kitchen knife");
  });

  it("walks over and picks things up", () => {
    const { store, play, player } = setup();
    const r = play("take the coat");
    expect(r.ops).toEqual([
      { op: "set_zone", id: PLAYER, zone: "window" },
      { op: "hold", character: PLAYER, item: "item:coat" },
    ]);
    expect(player().scene.hands.right).toBe("item:coat");
    expect(store.getEntity("item:coat")!.parent_id).toBe(PLAYER);
  });

  it("fails on concrete contradictions", () => {
    const { parse } = setup();
    expect(parse("take apple")).toMatchObject({ kind: "fail", reason: "You already have the apple." });
    expect(parse("remove apple")).toMatchObject({ kind: "fail", reason: "You aren't wearing the apple." });
    expect(parse("drop the coat")).toMatchObject({ kind: "fail", reason: "You aren't carrying the coat." });
    expect(parse("go to bedroom")).toMatchObject({ kind: "fail" });
  });

  it("defers to the LLM when unsure or when it isn't a simple action", () => {
    const { parse, log } = setup();
    expect(parse("take keys")).toBeNull();
    expect(parse("take the ring")).toBeNull();
    expect(parse("take the bed")).toBeNull();
    expect(parse("take the keys from mara")).toBeNull();
    expect(parse("I pull out a gun and shoot Mara")).toBeNull();
    expect(parse("drop the gun")).toBeNull();
    expect(parse("go to shop")).toBeNull();
    log.commit({
      kind: "author",
      input: "cups",
      source: "author",
      ops: [
        { op: "create_entity", kind: "item", name: "cup", parent: "room:bedroom", zone: "window" },
        { op: "create_entity", kind: "item", name: "cup", parent: "room:bedroom", zone: "window" },
      ],
    });
    expect(parse("take cup")).toBeNull();
  });

  it("wears, removes, drops and gives", () => {
    const { store, play, player } = setup();
    play("put on the coat");
    expect(player().scene.worn.torso).toBe("item:coat");
    play("take off coat");
    expect(player().scene.worn.torso).toBeUndefined();
    const give = play("give apple to mara");
    // Wearing the coat walked you to the window, which is adjacent to Mara's bed.
    expect(give.ops).toEqual([{ op: "give", from: PLAYER, to: "character:mara", item: "item:apple" }]);
    expect(store.getEntity("item:apple")!.parent_id).toBe("character:mara");
    play("drop coat");
    expect(store.getEntity("item:coat")!.parent_id).toBe("room:bedroom");
  });

  it("moves between zones and connected rooms", () => {
    const { store, play, player } = setup();
    play("go to the window");
    expect(player().scene.zone).toBe("window");
    play("walk over to mara");
    expect(player().scene.zone).toBe("bed");
    play("go to the kitchen");
    expect(store.getEntity(PLAYER)!.parent_id).toBe("room:kitchen");
    play("take knife");
    expect(player().scene.hands.right).toBe("item:knife");
  });

  it("uses recorded exits when present", () => {
    const { store, log, parse } = setup();
    log.commit({
      kind: "author",
      input: "exits",
      source: "author",
      ops: [
        { op: "create_entity", id: "room:hall", kind: "room", name: "Hall", parent: "place:house" },
      ],
    });
    const bedroom = store.getEntity("room:bedroom")!;
    store.putEntity({ ...bedroom, props: { ...bedroom.props, exits: ["room:hall"] } });
    expect(parse("go to kitchen")).toBeNull();
    expect(parse("enter the hall")).toMatchObject({ kind: "ops" });
  });

  it("handles waiting and sleep", () => {
    const { parse } = setup();
    expect(parse("wait 2 hours")).toMatchObject({ ops: [{ op: "time_advance", minutes: 120 }] });
    expect(parse("wait")).toMatchObject({ ops: [{ op: "time_advance", minutes: 10 }] });
    expect(parse("sleep")).toMatchObject({ kind: "ops" });
    expect(parse("look")).toEqual({ kind: "look" });
  });

  it("refuses physical fast-path actions while restrained", () => {
    const { log, parse } = setup();
    log.commit({
      kind: "author",
      input: "restrain",
      source: "author",
      ops: [{ op: "relation", id: PLAYER, add: [{ type: "restrained_by", target: "character:mara" }] }],
    });
    expect(parse("go to kitchen")).toBeNull();
    expect(parse("take coat")).toBeNull();
    expect(parse("wait")).toMatchObject({ kind: "ops" });
  });
});
