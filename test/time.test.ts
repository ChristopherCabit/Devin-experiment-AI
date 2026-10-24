import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { appointmentAt, describeScene } from "../src/game/context.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID, STARTER } from "../src/game/seeds.js";
import type { ChatRequest } from "../src/llm/client.js";
import { appointments, clockMinutes } from "../src/world/queries.js";
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
