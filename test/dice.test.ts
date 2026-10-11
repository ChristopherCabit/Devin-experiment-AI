import { describe, expect, it } from "vitest";
import { resolveCheck } from "../src/game/dice.js";

const fixed = (roll: number) => () => (roll - 1) / 20;

describe("resolveCheck", () => {
  it("scales with capability vs opposition", () => {
    expect(resolveCheck("hard", 3, 3, fixed(10)).outcome).toBe("failure");
    expect(resolveCheck("hard", 7, 3, fixed(10)).outcome).toBe("success");
    expect(resolveCheck("moderate", 1, 7, fixed(15)).outcome).toBe("failure_with_complication");
  });
  it("treats trivial as automatic and natural 20/1 as extremes", () => {
    expect(resolveCheck("trivial", 0, 10, fixed(1)).outcome).toBe("success");
    expect(resolveCheck("extreme", 0, 3, fixed(20)).outcome).toBe("success");
    expect(resolveCheck("easy", 3, 3, fixed(1)).outcome).toBe("failure_with_complication");
  });
});
