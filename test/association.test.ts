import { describe, expect, it } from "vitest";
import { decodeVector, encodeVector, normalize, standouts, stirredBy, type Candidate, type RecallContext } from "../src/game/association.js";
import { maskOps, narrate, repeatEnd, sentencesFrom } from "../src/game/narrate.js";
import { LlmAborted, LlmClient, type ChatRequest } from "../src/llm/client.js";

const unit = (i: number, n = 30) => normalize(Array.from({ length: n }, (_, k) => (k === i ? 1 : 0.05)));

describe("memory vectors", () => {
  it("round-trip through int8 storage keeping their direction", () => {
    const v = normalize([0.3, -0.2, 0.9, 0.01, -0.7]);
    const back = decodeVector(encodeVector(v));
    expect(back.reduce((a, x, i) => a + x * (v[i] ?? 0), 0)).toBeGreaterThan(0.999);
  });

  it("only a memory that clearly stands out from the rest comes to mind", () => {
    const t = (n: number) => ({ n, created_at: n, kind: "do", input: "", output: "x" }) as never;
    const cands: Candidate[] = Array.from({ length: 30 }, (_, i) => ({ t: t(i + 1), prev: undefined, v: unit(i), who: [{ id: "character:mara", name: "Mara" } as never], s: 2 }));
    const meta = new Map<string, unknown>();
    const store = { getMeta: (k: string, f: unknown) => (meta.has(k) ? meta.get(k) : f), setMeta: (k: string, v: unknown) => meta.set(k, v), allEntities: () => [], getEntity: () => null } as never;
    const ctx: RecallContext = { store, playerId: "character:you", times: new Map(), now: 0, turnNo: 50, rng: () => 0 };
    expect(standouts(unit(3), cands)[0]?.c.t.n).toBe(4);
    expect(stirredBy(ctx, unit(3), cands, new Set())?.t.n).toBe(4);
    expect(stirredBy(ctx, normalize(Array(30).fill(1)), cands, new Set())).toBeNull();
    expect(stirredBy(ctx, unit(3), cands, new Set([4]))).toBeNull();
  });
});

describe("sentences of a streamed passage", () => {
  it("skip op blocks and JSON, and wait for a sentence to finish", () => {
    const raw = '<ops>\n{"op":"time_advance","minutes":5}\n</ops>\nRain hammers on the old shutters all night long. Mara looks up from the bar at y';
    const m = maskOps(raw);
    expect(m.length).toBe(raw.length);
    const ss = sentencesFrom(m, 0, false).map(({ s, e }) => m.slice(s, e).trim());
    expect(ss).toEqual(["Rain hammers on the old shutters all night long."]);
    expect(sentencesFrom(m, 0, true)).toHaveLength(2);
  });

  it("find where a continuation that restarted stops repeating", () => {
    const kept = "Rain hammers on the shutters. Mara sets the cup down without a word. ";
    const cont = "Mara sets the cup down without a word. She looks at you.";
    expect(cont.slice(repeatEnd(kept, cont)).trim()).toBe("She looks at you.");
    expect(repeatEnd(kept, "She looks at you.")).toBe(0);
  });
});

function streamer(rounds: string[][], sent: ChatRequest[]) {
  return {
    async chat(req: ChatRequest) {
      sent.push(req);
      const parts = rounds[sent.length - 1] ?? [];
      let text = "";
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, 5));
        if (req.signal?.aborted) throw new LlmAborted(Promise.resolve(0.0005));
        text += p;
        req.onText?.(text);
      }
      return { text, promptTokens: 1, completionTokens: 1, costUsd: 0.001 };
    },
  };
}

describe("remembering partway through a passage", () => {
  it("stops before the sentence that brings a memory back, keeps what was written, and continues from there", async () => {
    const sent: ChatRequest[] = [];
    const llm = streamer(
      [
        ["The fire has burned low and the room is quiet now. ", "Mara turns the little wooden fox over in her hands. ", "She says nothing at all for a long while."],
        ["She sets the fox back on the shelf, beside Elsbeth's name."],
      ],
      sent,
    );
    const shown: string[] = [];
    const r = await narrate(llm, { model: "m", messages: [{ role: "user", content: "go" }], maxTokens: 10 }, {
      watch: async (ss) => {
        const i = ss.findIndex((s) => /fox over/.test(s.split(". ").at(-1) ?? s));
        return i >= 0 ? { index: i, memory: "Mara (Day 1): You give Mara a carved fox." } : null;
      },
      show: (t) => shown.push(t),
      maxPauses: 2,
      resume: (soFar, memory) => `SO FAR:${soFar}\nMEMORY:${memory}`,
    });
    expect(r.pauses).toBe(1);
    expect(r.text).toBe("The fire has burned low and the room is quiet now. She sets the fox back on the shelf, beside Elsbeth's name.");
    expect(shown.some((s) => /turns the little wooden fox/.test(s))).toBe(false);
    expect(sent[1]?.messages.at(-1)?.content).toBe("SO FAR:The fire has burned low and the room is quiet now.\nMEMORY:Mara (Day 1): You give Mara a carved fox.");
    expect(r.costUsd).toBeCloseTo(0.0015);
  });

  it("writes straight through when nothing comes to mind", async () => {
    const sent: ChatRequest[] = [];
    const llm = streamer([["Rain falls on the roofs of the town all evening. ", "You wait by the fire and watch it burn."]], sent);
    const r = await narrate(llm, { model: "m", messages: [], maxTokens: 10 }, { watch: async () => null, show: () => undefined, maxPauses: 2, resume: () => "" });
    expect(sent).toHaveLength(1);
    expect(r.text).toBe("Rain falls on the roofs of the town all evening. You wait by the fire and watch it burn.");
  });
});

describe("embeddings", () => {
  it("embed through zero-retention routing at the requested size and record the cost", async () => {
    let body: Record<string, unknown> = {};
    let recorded = 0;
    const fetch = (_u: string, init: { body?: string }) => {
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ embedding: [1, 0] }], usage: { cost: 0.00001 } }) });
    };
    const c = new LlmClient({ apiKey: "k", meter: { status: () => ({ blocked: false }), record: (x: number) => (recorded += x) } as never, fetch: fetch as never });
    const r = await c.embed("qwen/qwen3-embedding-8b", ["a carved fox"], 1024);
    expect(body).toMatchObject({ model: "qwen/qwen3-embedding-8b", dimensions: 1024, provider: { zdr: true, data_collection: "deny" } });
    expect(r.vectors).toEqual([[1, 0]]);
    expect(recorded).toBeCloseTo(0.00001);
  });
});
