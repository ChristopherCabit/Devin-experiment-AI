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

describe("tool calls", () => {
  it("answers a streamed tool call mid-generation, continues, and stops offering tools after the limit", async () => {
    const sent: Record<string, unknown>[] = [];
    const rounds = [
      ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"recall","arguments":"{\\"query\\":"}}]}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"fox\\"}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"cost":0.001}}\n\ndata: [DONE]\n\n'],
      ['data: {"choices":[{"delta":{"content":"She turns the fox over."}}],"usage":{"prompt_tokens":9,"completion_tokens":6,"cost":0.002}}\n\ndata: [DONE]\n\n'],
    ];
    const fetch = (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), body: sse(rounds[sent.length - 1] ?? []) });
    };
    let recorded = 0;
    const meter = { status: () => ({ blocked: false }), record: (c: number) => (recorded += c) };
    const c = new LlmClient({ apiKey: "k", meter: meter as never, fetch: fetch as never });
    const asked: string[] = [];
    const seen: string[] = [];
    const r = await c.chat({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      maxTokens: 50,
      onText: (t) => seen.push(t),
      tools: [{ name: "recall", description: "d", parameters: { type: "object" } }],
      maxToolCalls: 1,
      onTool: (n, a) => (asked.push(`${n} ${a}`), "### Day 1, 20:00\nYou give Mara a carved fox."),
    });
    expect(asked).toEqual(['recall {"query":"fox"}']);
    expect(r).toEqual({ text: "She turns the fox over.", promptTokens: 14, completionTokens: 9, costUsd: 0.003 });
    expect(recorded).toBeCloseTo(0.003);
    expect(seen.at(-1)).toBe("She turns the fox over.");
    expect(sent[0]?.tool_choice).toBe("auto");
    expect(sent[1]?.tool_choice).toBe("none");
    expect(sent[1]?.provider).toEqual({ zdr: true, data_collection: "deny" });
    const msgs = sent[1]?.messages as { role: string; tool_call_id?: string; content: string }[];
    expect(msgs.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "recall", arguments: '{"query":"fox"}' } }] });
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
});

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
