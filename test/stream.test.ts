import { describe, expect, it } from "vitest";
import { visibleProse } from "../src/game/pipeline.js";
import { LlmClient } from "../src/llm/client.js";

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

describe("streaming", () => {
  it("accumulates deltas across split chunks, reports progress and records cost", async () => {
    let recorded = 0;
    let sent: Record<string, unknown> = {};
    const meter = { status: () => ({ blocked: false }), record: (c: number) => (recorded += c) };
    const fetch = (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        body: sse([
          ': keepalive\n\ndata: {"choices":[{"delta":{"content":"You "}}]}\n\ndata: {"choi',
          'ces":[{"delta":{"content":"wait."}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.0004}}\n\ndata: [DONE]\n\n',
        ]),
      });
    };
    const c = new LlmClient({ apiKey: "k", meter: meter as never, fetch: fetch as never });
    const seen: string[] = [];
    const r = await c.chat({ model: "m", messages: [], maxTokens: 10, onText: (t) => seen.push(t) });
    expect(sent.stream).toBe(true);
    expect(sent.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(seen).toEqual(["You ", "You wait."]);
    expect(r).toEqual({ text: "You wait.", promptTokens: 5, completionTokens: 2, costUsd: 0.0004 });
    expect(recorded).toBe(0.0004);
  });

  it("partial drafts never show ops, raw JSON or a line written for the player", () => {
    expect(visibleProse('<ops>\n{"op":"move"')).toBe("");
    expect(visibleProse('<ops>{"op":"time_advance","minutes":5}</ops>\nYou wait.<o')).toBe("You wait.");
    expect(visibleProse('{"ops":[{"op":"time_adv')).toBe("");
    expect(visibleProse("Rain falls.\n> You feel")).toBe("Rain falls.");
  });
});
