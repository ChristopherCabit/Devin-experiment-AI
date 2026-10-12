import { describe, expect, it, vi } from "vitest";
import { Game, GameError } from "../src/app/game.js";
import { LlmClient, type ChatRequest } from "../src/llm/client.js";
import { MemoryFiles } from "../src/platform/files.js";

function open(cost = 0.01) {
  const files = new MemoryFiles();
  const game = Game.open({
    files,
    // Mirrors LlmClient: every call is recorded on the meter.
    llm: (meter) => ({
      chat: (req: ChatRequest) => {
        const costUsd = req.maxTokens > 0 ? cost : 0;
        meter.record(costUsd);
        return Promise.resolve({ text: "<ops></ops>SECRET STORY TEXT", promptTokens: 1, completionTokens: 1, costUsd });
      },
    }),
  });
  return { files, game };
}

describe("game", () => {
  it("starts in the starter world and persists every turn", async () => {
    const { files, game } = open();
    const g = await game;
    expect(g.state().turns[0]!.output).toMatch(/Lantern Inn/);
    await g.turn("say", "hello");
    const n = g.state().turns.length;
    const again = await Game.open({ files });
    expect(again.state().turns).toHaveLength(n);
  });

  it("enforces the spend cap across saves, and undo still works", async () => {
    const g = await open().game;
    await g.setConfig({ capUsd: 0.2 });
    let capped = false;
    for (let i = 0; i < 50 && !capped; i++) await g.turn("say", "hi").catch(() => (capped = true));
    expect(capped).toBe(true);
    await g.newSave("Other");
    await expect(g.turn("say", "hi")).rejects.toThrow(/cap/);
    await g.loadSave(g.listSaves().find((s) => s.name === "Adventure")!.id);
    await expect(g.undo()).resolves.toBeTruthy();
  });

  it("stores the API key without ever returning it", async () => {
    const files = new MemoryFiles();
    const g = await Game.open({ files });
    await expect(g.turn("do", "look")).rejects.toThrow(GameError);
    await g.setConfig({ apiKey: "sk-or-test-123" });
    expect(JSON.stringify(g.state())).not.toMatch(/sk-or/);
    expect(g.config()).toEqual({ hasKey: true, capUsd: 14 });
  });

  it("never writes story text to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const g = await open().game;
    await g.turn("say", "PRIVATE PLAYER TEXT");
    const out = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(out).not.toMatch(/PRIVATE|SECRET|Lantern/);
    for (const s of spies) s.mockRestore();
  });

  it("pins zero-data-retention routing on every request", () => {
    expect(LlmClient.requestBody({ model: "m", messages: [], maxTokens: 1 }).provider).toEqual({ zdr: true, data_collection: "deny" });
  });
});
