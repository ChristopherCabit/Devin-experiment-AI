import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { DEFAULT_SETTINGS, describeScene, type WorldSettings } from "../src/game/context.js";
import { playTurn } from "../src/game/pipeline.js";
import { cultivateOps, trainOps } from "../src/game/rules.js";
import { selectHint, spawnSubject } from "../src/game/secrets.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import { blankDraft, buildSeed, PlayerSpec, WorldBrief, WorldDraft } from "../src/game/setup.js";
import type { ChatRequest } from "../src/llm/client.js";
import { applyOp, applyOps } from "../src/ops/apply.js";
import { charProps, secrets } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

function world(replies: string[] = [], rng = () => 0.5) {
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
  return { store, log, calls, deps: { store, log, llm, playerId: PLAYER_ID, rng } };
}
const engine = { source: "engine" as const, turn: 1 };
const playerRoom = (store: WorldStore) => store.getEntity(PLAYER_ID)!.parent_id!;

describe("secrets", () => {
  it("only the engine creates secrets; the narrator may reveal one, which then shows as known", () => {
    const { store } = world();
    expect(applyOp(store, { op: "secret", text: "Rook poisoned the well.", subjects: ["character:rook"] }, { source: "narrator", turn: 1 }).ok).toBe(false);
    const r = applyOp(store, { op: "secret", text: "Rook poisoned the well.", kind: "danger", subjects: ["character:rook"] }, engine);
    expect(r.ok && r.id).toBe("secret:1");
    expect(describeScene(store, PLAYER_ID).text).not.toMatch(/poisoned/);
    expect(applyOp(store, { op: "reveal", id: "secret:1" }, { source: "narrator", turn: 2 }).ok).toBe(true);
    expect(describeScene(store, PLAYER_ID).text).toMatch(/uncovered:\n- Rook poisoned/);
  });

  it("hints only in-scope secrets, never in quiet moments unless a threat is active, and respects the cooldown", () => {
    const { store } = world();
    applyOps(store, [
      { op: "secret", text: "Mara is a spy.", subjects: ["character:mara"] },
      { op: "secret", text: "A vault lies under the far city.", subjects: ["region:marrow"], kind: "boon" },
      { op: "create_entity", id: "place:far", kind: "place", name: "Far keep", parent: "region:marrow" },
      { op: "secret", text: "The far keep's well is poisoned.", subjects: ["place:far"] },
    ], engine);
    expect(selectHint(store, PLAYER_ID, "quiet", 10, () => 0)).toBeNull();
    const h = selectHint(store, PLAYER_ID, "investigating", 10, () => 0)!;
    expect(h.secret.text).not.toMatch(/far keep/);
    applyOps(store, h.ops, { source: "engine", turn: 10 });
    expect(selectHint(store, PLAYER_ID, "exploring", 11, () => 0)).toBeNull();
    applyOp(store, { op: "secret", text: "Something hunts you.", kind: "horror", urgency: "active", subjects: ["region:marrow"] }, engine);
    expect(selectHint(store, PLAYER_ID, "quiet", 30, () => 0)?.secret.text).toBe("Something hunts you.");
  });

  it("ordinary rooms never become secret subjects; notable rooms and new places can", () => {
    const { store } = world();
    applyOps(store, [
      { op: "create_entity", id: "place:bath", kind: "place", name: "Bathhouse", parent: "region:marrow", props: { notable: false } },
      { op: "create_entity", id: "room:tub", kind: "room", name: "Tub room", parent: "place:bath" },
      { op: "move", id: PLAYER_ID, to: "room:tub" },
    ], { source: "author", turn: 5 });
    for (let i = 0; i < 50; i++) expect(spawnSubject(store, PLAYER_ID, "exploring", 6, () => i / 50)).toBeNull();
    applyOp(store, { op: "create_entity", id: "room:crypt", kind: "room", name: "Crypt", parent: "place:bath", props: { notable: true } }, { source: "author", turn: 6 });
    applyOp(store, { op: "move", id: PLAYER_ID, to: "room:crypt" }, { source: "author", turn: 6 });
    expect(spawnSubject(store, PLAYER_ID, "exploring", 7, () => 0.1)?.id).toBe("room:crypt");
  });

  it("the narrator sees the one selected secret and can reveal it", async () => {
    const parsed = JSON.stringify({ attempt: "searches Rook's pack", kind: "trivial", difficulty: "easy", pace: "investigating" });
    const { store, calls, deps } = world([parsed, '<ops>\n{"op":"reveal","id":"secret:1"}\n</ops>\nA bloodied signet ring.']);
    applyOp(store, { op: "secret", text: "Rook carries the murdered lord's ring.", subjects: ["character:rook"] }, engine);
    await playTurn(deps, "do", "I search Rook's pack while he sleeps");
    expect(calls[1]!.messages.at(-1)!.content).toMatch(/Hidden from the protagonist\n.*murdered lord's ring/);
    expect(secrets(store)[0]).toMatchObject({ revealed: true, hinted_turn: expect.any(Number) });
  });

  it("world generation's secrets attach to the named places and people", () => {
    const b = WorldBrief.parse({ title: "T" });
    const world = WorldDraft.parse({
      ...blankDraft(b, "Abbey", "Nave"),
      npcs: [{ name: "Brother Ilo", age: 50, description: "monk", sheet: {} }],
      secrets: [{ text: "Ilo hides a relic.", kind: "boon", about: ["Brother Ilo", "Nave"], known_by: ["Brother Ilo"] }],
    });
    const seed = buildSeed({ name: "x", brief: b, world, statsMode: "freeform", player: PlayerSpec.parse({ name: "A", age: 20 }) });
    expect(seed.ops.find((o) => (o as { op: string }).op === "secret")).toMatchObject({ subjects: ["character:brother_ilo", "room:nave"], known_by: ["character:brother_ilo"] });
  });
});

describe("cultivation and mentors", () => {
  const cult: WorldSettings = { ...DEFAULT_SETTINGS, progression: { practice: true, mentors: true, cultivation: { realms: ["Mortal", "Qi Condensation", "Foundation"], resource: "spirit stones" } } };

  it("cultivating builds progress, spends the resource, and breaks through on a good roll", () => {
    const { store } = world();
    applyOp(store, { op: "author_update", id: PLAYER_ID, props: { ...store.getEntity(PLAYER_ID)!.props, sheet: { ...charProps(store.getEntity(PLAYER_ID)!).sheet, resources: { hp: { value: 10, max: 10 }, "spirit stones": { value: 1, max: 99 } } } } }, { source: "author", turn: 1 });
    const a = cultivateOps(store, PLAYER_ID, cult, () => 0.99)!;
    expect(a.note).toMatch(/progress 5\/6 \(used 1 spirit stones\)/);
    applyOps(store, a.ops, engine);
    const b = cultivateOps(store, PLAYER_ID, cult, () => 0.99)!;
    expect(b.note).toMatch(/breakthrough to Qi Condensation/);
    applyOps(store, b.ops, engine);
    const sheet = charProps(store.getEntity(PLAYER_ID)!).sheet;
    expect(sheet.abilities.cultivation).toBe(1);
    expect(sheet.power_tier).toBe(4);
  });

  it("a badly failed breakthrough causes a qi deviation", () => {
    const { store } = world();
    applyOp(store, { op: "practice", character: PLAYER_ID, key: "cultivation", value: 5 }, engine);
    const r = cultivateOps(store, PLAYER_ID, cult, () => 0)!;
    applyOps(store, r.ops, engine);
    expect(r.note).toMatch(/qi deviation/);
    expect(store.getEntity(PLAYER_ID)!.props.conditions).toContain("qi deviation");
  });

  it("a mentor trains a skill only up to their own level", () => {
    const { store } = world();
    applyOp(store, { op: "move", id: "character:rook", to: playerRoom(store) }, { source: "author", turn: 1 });
    for (let i = 0; i < 20; i++) applyOps(store, trainOps(store, PLAYER_ID, "character:rook", "swordsmanship", cult)!.ops, engine);
    expect(charProps(store.getEntity(PLAYER_ID)!).sheet.skills.swordsmanship).toBe(6);
    expect(trainOps(store, PLAYER_ID, "character:rook", "swordsmanship", cult)!.note).toMatch(/nothing more to teach/);
  });
});
