import { describe, expect, it } from "vitest";
import { seedWorld } from "../src/app/game.js";
import { hourFromText } from "../src/game/setup.js";
import { STARTER } from "../src/game/seeds.js";
import { TurnLog } from "../src/engine/turns.js";
import { WorldStore } from "../src/world/store.js";
import { clockMinutes } from "../src/world/queries.js";

describe("start time", () => {
  it("reads the time of day from an opening", () => {
    expect(hourFromText("Dawn light creeps over the wall.")).toBe(6);
    expect(hourFromText("The evening crowd thins.")).toBe(19);
    expect(hourFromText("You sit at your desk.")).toBeNull();
  });
  it("new worlds do not start at midnight unless they say so", () => {
    for (const [opening, hour] of [["You sit at your desk.", 10], ["Dawn breaks over the docks.", 6]] as const) {
      const store = new WorldStore();
      seedWorld(store, new TurnLog(store), { ...STARTER, opening, ops: STARTER.ops.filter((o) => o.op !== "time_advance") });
      expect(clockMinutes(store)).toBe(hour * 60);
      expect(store.getMeta("life_tick", -1)).toBe(hour * 60);
    }
    const store = new WorldStore();
    seedWorld(store, new TurnLog(store));
    expect(clockMinutes(store)).toBe(19 * 60);
  });
});
