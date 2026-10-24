import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { appointmentAt, describeScene, getSettings } from "../src/game/context.js";
import { playTurn, waitTarget } from "../src/game/pipeline.js";
import { applyOps } from "../src/ops/apply.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import type { ChatRequest } from "../src/llm/client.js";
import { appointments, clockMinutes, references } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

function world(reply: (req: ChatRequest) => string) {
  const store = new WorldStore();
  const log = new TurnLog(store);
  log.commit({ kind: "author", input: "seed", ops: STARTER.ops, source: "author" });
  const llm = { chat: (req: ChatRequest) => Promise.resolve({ text: reply(req), promptTokens: 0, completionTokens: 0, costUsd: 0 }) };
  return { store, log, deps: { store, log, llm, playerId: PLAYER_ID, rng: () => 0.5 } };
}

describe("appointment times", () => {
  it("reads a passed 12-hour time as the later one, and other passed times as tomorrow", () => {
    expect(appointmentAt(15 * 60, "7:00", 0)).toBe(19 * 60);
    expect(appointmentAt(15 * 60, "19:00", 0)).toBe(19 * 60);
    expect(appointmentAt(22 * 60, "9:00", 0)).toBe(1440 + 9 * 60);
    expect(appointmentAt(21 * 60, "8:00", 1)).toBe(1440 + 8 * 60);
    expect(appointmentAt(0, "soon", 0)).toBeNull();
  });
});

describe("scheduled events", () => {
  it("the review records a stated time, the scene shows it counting down, and undo removes it", async () => {
    const { store, log, deps } = world((req) =>
      /keep the game's records/.test(String(req.messages[0]?.content))
        ? JSON.stringify({ appointments: [{ text: "supper with Mara", time: "9:00", days_ahead: 0, who: ["character:mara"] }] })
        : '<ops></ops>Mara wipes the bar. "Supper\'s at nine, if you\'re staying."',
    );
    await playTurn(deps, "say", "Is there food later?");
    const [a] = appointments(store);
    expect(a?.at).toBe(Math.floor(clockMinutes(store) / 1440) * 1440 + 21 * 60);
    expect(describeScene(store, PLAYER_ID).text).toMatch(/Scheduled: supper with Mara at Day 1, 21:00 \(in 2 h 0 min\)/);
    expect(describeScene(store, PLAYER_ID).text).toMatch(/Time: Day 1, 19:\d\d \(evening\)/);
    log.undo();
    expect(appointments(store)).toHaveLength(0);
  });
});

describe("research", () => {
  it("looks up a real thing the story mentions in the background and shows the note to the narrator once it is in", async () => {
    const reqs: ChatRequest[] = [];
    const { store, log, deps } = world((req) => {
      reqs.push(req);
      const sys = String(req.messages[0]?.content);
      if (/keep the game's records/.test(sys)) return JSON.stringify({ references: [{ subject: "Hollow Knight (video game)", query: "Hollow Knight video game bosses" }] });
      if (req.web) return "Bosses include the [False Knight](https://x.example) and Hornet.";
      return "<ops></ops>Mara shrugs. \"Never heard of Hollow Knight.\"";
    });
    const s = { ...getSettings(store), research: true };
    store.setMeta("settings", s);
    await playTurn(deps, "say", "Ever played Hollow Knight?");
    const look = reqs.find((r) => r.web);
    expect(look?.messages.at(-1)?.content).toBe("Hollow Knight video game bosses");
    await playTurn(deps, "say", "The Hollow Knight bosses are brutal.");
    expect(references(store).map((r) => r.note)).toEqual(["Bosses include the False Knight and Hornet."]);
    const narr = reqs.filter((r) => /Story so far/.test(String(r.messages[1]?.content))).at(-1);
    expect(String(narr?.messages[1]?.content)).toMatch(/Real-world reference[\s\S]*False Knight/);
    log.undo();
    expect(references(store)).toHaveLength(0);
  });
});

describe("waitTarget", () => {
  it("lands an explicit wait exactly on the named scheduled event", () => {
    const { store } = world(() => "");
    const now = clockMinutes(store);
    applyOps(store, [{ op: "appointment", text: "supper at Mara's", at: now + 125, who: [] }], { source: "engine", turn: 1 });
    expect(waitTarget(store, "wait by the fire until supper")).toBe(125);
    expect(waitTarget(store, "wait for Mara")).toBe(125);
    expect(waitTarget(store, "sit by the fire")).toBeNull();
    expect(waitTarget(store, "wait until dawn")).toBeNull();
  });
});

describe("schedule changes", () => {
  it("moves a scheduled event later when the story gives a reason, shows the old time, and undo puts it back", async () => {
    let review: unknown = {};
    const { store, log, deps } = world((req) => (/keep the game's records/.test(String(req.messages[0]?.content)) ? JSON.stringify(review) : '<ops></ops>Mara swears at the oven. "Supper\'ll be late. Half nine."'));
    const now = clockMinutes(store);
    const hh = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    applyOps(store, [{ op: "appointment", text: "supper at Mara's", at: now + 120, who: [] }], { source: "engine", turn: 0 });
    review = { schedule_changes: [{ text: "Supper at Mara's", change: "moved", time: hh(now + 150), days_ahead: 0 }] };
    await playTurn(deps, "say", "Is supper still on?");
    expect(appointments(store)[0]?.at).toBe(now + 150);
    expect(describeScene(store, PLAYER_ID).text).toMatch(/supper at Mara's at .*moved from/);
    review = { schedule_changes: [{ text: "supper", change: "cancelled", time: null }] };
    await playTurn(deps, "say", "Forget it then.");
    expect(appointments(store)).toHaveLength(0);
    log.undo();
    expect(appointments(store)[0]?.at).toBe(now + 150);
    log.undo();
    expect(appointments(store)[0]?.at).toBe(now + 120);
  });
});
