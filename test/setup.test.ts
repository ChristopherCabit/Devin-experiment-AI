import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { seedWorld } from "../src/app/game.js";
import { DEFAULT_SETTINGS } from "../src/game/context.js";
import { playTurn } from "../src/game/pipeline.js";
import { consumeOps, effectiveTier, practiceOps } from "../src/game/rules.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { blankDraft, buildSeed, playerSheet, PlayerSpec, SetupError, WorldBrief } from "../src/game/setup.js";
import type { ChatRequest } from "../src/llm/client.js";
import { applyOp } from "../src/ops/apply.js";
import { charProps } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";
import { Sheet } from "../src/world/types.js";
import { memberSheet, seeded } from "../src/world/variance.js";

function world(replies: string[] = []) {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const calls: ChatRequest[] = [];
  const llm = {
    chat: (req: ChatRequest) => {
      calls.push(req);
      return Promise.resolve({ text: replies.shift() ?? "<ops></ops>Nothing happens.", promptTokens: 0, completionTokens: 0, costUsd: 0.001 });
    },
  };
  return { store, log, calls, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}
const brief = (o: Record<string, unknown> = {}) => WorldBrief.parse({ title: "T", powerCeiling: 6, ...o });
const player = (o: Record<string, unknown> = {}) => PlayerSpec.parse({ name: "Ash", age: 30, attributes: { strength: 4, agility: 4, wits: 3, charm: 3 }, skills: { stealth: 3 }, ...o });

describe("character creation", () => {
  it("point-buy enforces the budget and the cap; freeform skips only the budget; unbounded lifts both", () => {
    const rich = player({ skills: { a: 6, b: 6, c: 6 } });
    expect(() => playerSheet(rich, brief(), "pointbuy")).toThrow(SetupError);
    expect(() => playerSheet(rich, brief(), "proposed")).toThrow(/budget/);
    expect(playerSheet(rich, brief(), "freeform").skills.a).toBe(6);
    const god = player({ abilities: { lightning: 10 } });
    expect(() => playerSheet(god, brief(), "freeform")).toThrow(/cap of 6/);
    expect(playerSheet(god, brief({ unboundedPower: true }), "pointbuy").abilities.lightning).toBe(10);
  });

  it("a blank world can start the player completely alone", () => {
    const b = brief({ situation: "You wake on a raft." });
    const seed = buildSeed({ name: "x", brief: b, world: blankDraft(b, "The Sea", "Raft"), statsMode: "pointbuy", player: player({ coin: 2, items: ["oar"] }) });
    const store = new WorldStore();
    seedWorld(store, new TurnLog(store), seed);
    const chars = store.allEntities().filter((e) => e.kind === "character");
    expect(chars.map((c) => c.id)).toEqual([PLAYER_ID]);
    expect(store.getEntity("item:oar")?.parent_id).toBe(PLAYER_ID);
    expect(charProps(chars[0]!).sheet.resources.coin?.value).toBe(2);
  });
});

describe("groups", () => {
  it("named members vary around the group's sheet, with rare strong and weak outliers", () => {
    const t = Sheet.parse({ power_tier: 5, skills: { spear: 5 }, resources: { hp: { value: 12, max: 12 } } });
    expect(memberSheet(t, seeded("a"))).toEqual(memberSheet(t, seeded("a")));
    const spears = Array.from({ length: 400 }, (_, i) => memberSheet(t, seeded(`m${i}`)).skills.spear!);
    expect(Math.min(...spears)).toBeLessThanOrEqual(2);
    expect(Math.max(...spears)).toBeGreaterThanOrEqual(8);
    expect(spears.filter((v) => Math.abs(v - 5) <= 1).length).toBeGreaterThan(300);
  });

  it("split_member singles out one member and lowers the count; numbers help the group in a check", () => {
    const { store } = world();
    const ctx = { source: "narrator" as const, turn: 1 };
    applyOp(store, { op: "create_entity", id: "character:guards", kind: "character", name: "guards", parent: "room:common", props: { age: 30, group: { count: 8 }, sheet: { power_tier: 4 } } }, ctx);
    expect(effectiveTier(store, store.getEntity("character:guards"), null)).toBe(7);
    const r = applyOp(store, { op: "split_member", group: "character:guards", name: "Sergeant Holt" }, ctx);
    expect(r.ok).toBe(true);
    expect(charProps(store.getEntity("character:guards")!).group?.count).toBe(7);
    const holt = charProps(store.getEntity((r as { id: string }).id)!);
    expect(holt.group).toBeNull();
    expect(Math.abs(holt.sheet.power_tier - 4)).toBeLessThanOrEqual(4);
  });
});

describe("narrator character edits", () => {
  it("may describe NPCs and add unseen stats, but not change existing stats, sheets, or the player", () => {
    const { store } = world();
    const ctx = { source: "narrator" as const, turn: 1 };
    expect(applyOp(store, { op: "update_character", id: "character:rook", goals: "get paid", add_stats: { skills: { swordsmanship: 1, archery: 4 } } }, ctx).ok).toBe(true);
    const rook = charProps(store.getEntity("character:rook")!);
    expect(rook.sheet.skills).toMatchObject({ swordsmanship: 6, archery: 4 });
    expect((rook as Record<string, unknown>).goals).toBe("get paid");
    expect(applyOp(store, { op: "update_character", id: "character:rook", sheet: { power_tier: 1 } }, ctx).ok).toBe(false);
    expect(applyOp(store, { op: "update_character", id: PLAYER_ID, add_stats: { abilities: { flight: 10 } } }, ctx).ok).toBe(false);
    expect(applyOp(store, { op: "practice", character: PLAYER_ID, key: "stealth", value: 99 }, ctx).ok).toBe(false);
  });
});

describe("progression", () => {
  it("practice accumulates and levels a skill at the threshold, never past the cap", () => {
    const { store } = world();
    const s = { ...DEFAULT_SETTINGS };
    let note: string | null = null;
    for (let i = 0; i < 4 && !note; i++) {
      const r = practiceOps(store, PLAYER_ID, "swordsmanship", "hard", "success", 4, 5, s);
      for (const op of r.ops) expect(applyOp(store, op, { source: "engine", turn: i }).ok).toBe(true);
      note = r.note;
    }
    expect(note).toBe("swordsmanship improved to 5");
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.skills.swordsmanship).toBe(5);
    expect(practiceOps(store, PLAYER_ID, "swordsmanship", "hard", "success", 5, 5, { ...s, powerCeiling: 5 }).ops).toEqual([]);
  });

  it("held gear adds a bonus; a carried tome raises a stat up to the cap and is used up", () => {
    const { store } = world();
    const ctx = { source: "author" as const, turn: 1 };
    applyOp(store, { op: "create_entity", id: "item:tome", kind: "item", name: "tome", parent: PLAYER_ID, props: { teaches: { fireball: 9 } } }, ctx);
    const used = consumeOps(store, PLAYER_ID, "item:tome", { ...DEFAULT_SETTINGS, powerCeiling: 5 })!;
    for (const op of used.ops) expect(applyOp(store, op, { source: "engine", turn: 1 }).ok).toBe(true);
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.skills.fireball).toBe(5);
    expect(store.getEntity("item:tome")).toBeNull();
    applyOp(store, { op: "create_entity", id: "item:charm", kind: "item", name: "charm", parent: PLAYER_ID, props: { grants: { stealth: 2 } } }, ctx);
    applyOp(store, { op: "hold", character: PLAYER_ID, item: "item:charm" }, ctx);
    expect(effectiveTier(store, store.getEntity(PLAYER_ID), "stealth")).toBe(4);
  });
});

describe("casting", () => {
  it("an opponent missing from the world is cast with real stats before the roll", async () => {
    const parsed = JSON.stringify({ attempt: "attacks the gate guard", kind: "risky", difficulty: "moderate", skill: "swordsmanship", opponent: "the gate guard" });
    const cast = JSON.stringify({ age: 35, power_tier: 5, attributes: { strength: 5 }, skills: { swordsmanship: 5 }, abilities: {}, hp: 13, count: null });
    const { store, calls, deps } = world([parsed, cast, "<ops></ops>Steel rings."]);
    const out = await playTurn(deps, "do", "I attack the gate guard");
    expect(calls[1]!.messages[0]!.content).toMatch(/assign game stats/);
    const guard = store.allEntities().find((e) => e.kind === "character" && /gate guard/i.test(e.name))!;
    expect(charProps(guard).sheet.skills.swordsmanship).toBe(5);
    expect(calls[2]!.messages.at(-1)!.content).toMatch(/swordsmanship 4 vs 5/);
    expect(out.text).toBe("Steel rings.");
  });

  it("narrator-created characters without a sheet are cast in the same turn", async () => {
    const parsed = JSON.stringify({ attempt: "looks around", kind: "social", difficulty: "easy" });
    const narration = '<ops>\n{"op":"create_entity","id":"character:thug","kind":"character","name":"thug","parent":"room:common","props":{"age":28}}\n</ops>\nA thug walks in.';
    const cast = JSON.stringify({ age: 28, power_tier: 4, attributes: {}, skills: { brawling: 4 }, abilities: {}, hp: 11, count: null });
    const { store, deps } = world([parsed, narration, cast]);
    await playTurn(deps, "do", "I look around the room for trouble");
    expect(charProps(store.getEntity("character:thug")!).sheet.skills.brawling).toBe(4);
  });
});
