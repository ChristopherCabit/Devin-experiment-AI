import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { getSettings } from "../src/game/context.js";
import { playTurn } from "../src/game/pipeline.js";
import { applyOps } from "../src/ops/apply.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import type { ChatRequest } from "../src/llm/client.js";
import { appointments } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

function world(reply: (req: ChatRequest) => string) {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const seen: ChatRequest[] = [];
  const llm = { chat: (req: ChatRequest) => (seen.push(req), Promise.resolve({ text: reply(req), promptTokens: 0, completionTokens: 0, costUsd: 0 })) };
  return { store, log, seen, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}
const isReview = (req: ChatRequest) => /keep the game's records/.test(String(req.messages[0]?.content));

describe("one character, many names", () => {
  it("records a nickname for someone present as an alias instead of a new character", async () => {
    const { store, deps } = world((req) =>
      isReview(req)
        ? JSON.stringify({ characters: [{ name: "Joy", description: "a barmaid" }], aliases: [{ id: "[character:mara]", name: "Joy" }] })
        : "<ops></ops>Rook raises his mug and calls her Joy, and Mara rolls her eyes at him.",
    );
    await playTurn(deps, "say", "Evening.");
    expect(store.allEntities().some((e) => e.name === "Joy")).toBe(false);
    expect(store.getEntity("character:mara")?.aliases).toContain("Joy");
  });

  it("merges a duplicate into the original, moving facts and schedule, and undo restores it", () => {
    const { store, log } = world(() => "");
    const mara = store.getEntity("character:mara");
    if (!mara) throw new Error("no Mara");
    store.putEntity({ ...mara, id: "character:joy", name: "Joy", aliases: ["Wednesday"] });
    const fact = store.addFact("Joy owes Rook a silver", ["character:joy", "character:rook"], 0);
    applyOps(store, [{ op: "appointment", text: "supper with Joy", at: 2000, who: ["character:joy"] }], { source: "engine", turn: 0 });
    log.commit({ kind: "author", input: "merge", source: "author", ops: [{ op: "merge_entity", from: "character:joy", into: "character:mara" }] });
    expect(store.getEntity("character:joy")).toBeNull();
    expect(store.getEntity("character:mara")?.aliases).toEqual(expect.arrayContaining(["Joy", "Wednesday"]));
    expect(store.facts().find((f) => f.id === fact)?.subjects).toEqual(["character:mara", "character:rook"]);
    expect(appointments(store)[0]?.who).toEqual(["character:mara"]);
    log.undo();
    expect(store.getEntity("character:joy")?.name).toBe("Joy");
    expect(store.facts().find((f) => f.id === fact)?.subjects).toContain("character:joy");
    expect(store.getEntity("character:mara")?.aliases).not.toContain("Joy");
  });

  it("refuses to merge the player away or across kinds", () => {
    const { log } = world(() => "");
    const r = log.commit({ kind: "author", input: "merge", source: "author", ops: [{ op: "merge_entity", from: PLAYER_ID, into: "character:mara" }] });
    expect(r.results[0]?.ok).toBe(false);
  });
});

describe("corrections fix the records", () => {
  it("merges characters the corrections call one person and retracts facts they contradict", async () => {
    const { store, log, deps } = world((req) =>
      isReview(req)
        ? JSON.stringify({ same_person: [{ from: "[character:joy]", into: "[character:mara]" }, { from: "character:wednesday", into: "character:mara" }, { from: "character:rook", into: "character:mara" }], retract_facts: [1] })
        : "<ops></ops>Mara nods.",
    );
    const mara = store.getEntity("character:mara");
    if (!mara) throw new Error("no Mara");
    store.putEntity({ ...mara, id: "character:joy", name: "Joy", aliases: [], parent_id: null });
    store.putEntity({ ...mara, id: "character:wednesday", name: "Wednesday", aliases: [], parent_id: null });
    store.addFact("Joy is Mara's sister", ["character:joy"], 0);
    store.setMeta("settings", { ...getSettings(store), corrections: "Mara is also called Joy and Wednesday; one person, and she has no sister." });
    await playTurn(deps, "say", "Evening.");
    expect(store.getEntity("character:joy")).toBeNull();
    expect(store.getEntity("character:wednesday")).toBeNull();
    expect(store.getEntity("character:rook")).not.toBeNull();
    expect(store.getEntity("character:mara")?.aliases).toContain("Joy");
    expect(store.facts().some((f) => /sister/.test(f.text))).toBe(false);
    log.undo();
    expect(store.getEntity("character:joy")?.name).toBe("Joy");
  });

  it("does nothing without corrections", async () => {
    const { store, deps } = world((req) => (isReview(req) ? JSON.stringify({ same_person: [{ from: "character:rook", into: "character:mara" }] }) : "<ops></ops>Mara nods."));
    await playTurn(deps, "say", "Evening.");
    expect(store.getEntity("character:rook")).not.toBeNull();
  });
});

describe("name stutters", () => {
  it("restores stuttered spellings of tracked names only", async () => {
    const { store } = world(() => "");
    const { nameFixer } = await import("../src/game/pipeline.js");
    const mara = store.getEntity("character:mara");
    if (!mara) throw new Error("no Mara");
    store.putEntity({ ...mara, id: "character:ella", name: "Ella", aliases: [] });
    const fix = nameFixer(store);
    expect(fix("Eella smiles. Ellla's cup, Maara and Mara. Ela waves; Bella too.")).toBe("Ella smiles. Ella's cup, Mara and Mara. Ela waves; Bella too.");
  });
});

describe("renames", () => {
  it("the narrator cannot rename someone to another character's name", () => {
    const { store } = world(() => "");
    const r = applyOps(store, [{ op: "rename", id: "character:rook", name: "Mara" }], { source: "narrator", turn: 1 });
    expect(r[0]?.ok).toBe(false);
    expect(store.getEntity("character:rook")?.name).toBe("Rook");
  });
});

describe("corrections", () => {
  it("reach the narrator and the record-keeper with top priority", async () => {
    const { store, seen, deps } = world((req) => (isReview(req) ? "{}" : "<ops></ops>Mara nods."));
    store.setMeta("settings", { ...getSettings(store), corrections: "Margaret is also called Joy; she is one person." });
    await playTurn(deps, "say", "Evening.");
    const systems = seen.map((r) => String(r.messages[0]?.content));
    expect(systems.some((s) => /PLAYER CORRECTIONS[^\n]*\nMargaret is also called Joy/.test(s))).toBe(true);
    expect(systems.some((s) => /keep the game's records[\s\S]*Player corrections[^\n]*Margaret/.test(s))).toBe(true);
  });
});

describe("ops never leak into the story", () => {
  it("catches unclosed blocks, fences, stray lines and arrays", async () => {
    const { splitNarration, visibleProse } = await import("../src/game/pipeline.js");
    const op = '{"op":"update_character","id":"character:mara","appearance":"freckles"}';
    const cases = [
      `<ops>\n${op}\n\nMara nods.`,
      `Mara nods.\n<ops>\n${op}\n</ops>`,
      `Mara nods.\n\`\`\`json\n${op}\n\`\`\``,
      `Mara nods.\n${op}`,
      `<ops>[${op}]</ops>\nMara nods.`,
      `<op>${op}</op>Mara nods.`,
      `\`\`\`json\n{"ops":[${op}]}\n\`\`\`\nMara nods.`,
    ];
    for (const c of cases) {
      const r = splitNarration(c);
      expect(r.prose, c).toBe("Mara nods.");
      expect(r.ops, c).toHaveLength(1);
      expect(visibleProse(c), c).toBe("Mara nods.");
    }
    expect(visibleProse(`Mara nods.\n{"op":"upda`)).toBe("Mara nods.");
    expect(splitNarration("She says [quietly] that {it} was fine.").prose).toBe("She says [quietly] that {it} was fine.");
  });
});

describe("stated positions", () => {
  it("records who argued which side and shows it in the scene", async () => {
    const { store, log, deps } = world((req) =>
      isReview(req)
        ? JSON.stringify({ stances: [{ who: "[character:mara]", topic: "reporting Rook", stance: "against; the guard is corrupt" }, { who: "character:you", topic: "reporting Rook", stance: "for" }, { who: "character:nobody", topic: "x", stance: "y" }] })
        : "<ops></ops>Mara shakes her head.",
    );
    await playTurn(deps, "say", "We should report Rook.");
    const { describeScene, stances, turnBlock } = await import("../src/game/context.js");
    expect(stances(store).map((s) => s.who).sort()).toEqual(["character:mara", "character:you"]);
    const scene = describeScene(store, "character:you").text;
    expect(scene).toContain("Mara, on reporting Rook: against; the guard is corrupt");
    expect(scene).toContain("You (the protagonist), on reporting Rook: for");
    expect(turnBlock({ kind: "say", input: "Hi", output: "Mara nods." })).toBe('> You say: "Hi"\nMara nods.');
    log.undo();
    expect(stances(store)).toEqual([]);
  });
});
