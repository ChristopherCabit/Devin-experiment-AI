import { describe, expect, it } from "vitest";
import { cleanStyle, cueKey, MusicDirector, musicPrompt, type Cue, type MusicSource } from "../src/game/music.js";
import type { FetchLike } from "../src/llm/client.js";
import { generateMusic } from "../src/llm/music.js";
import type { SpendMeter } from "../src/llm/spend.js";
import { MemoryFiles } from "../src/platform/files.js";

const tense: Cue = { mood: "tense", energy: "medium" };
const calm: Cue = { mood: "calm", energy: "low" };

function source(cues: Cue[], text = "<instrumental>") {
  const prompts: string[] = [];
  const src: MusicSource = {
    style: "medieval folk",
    tag: async () => cues.shift() ?? null,
    generate: async (p) => {
      prompts.push(p);
      return { audio: new Uint8Array([1, 2, 3]), text };
    },
  };
  return { src, prompts };
}

describe("music prompt", () => {
  it("is always instrumental and built only from tags and the style", () => {
    const p = musicPrompt(tense, 'Lute\n"and" <fiddle> {Mara}');
    expect(p).toMatch(/^Instrumental only: no vocals/);
    expect(p).toContain("tense, suspenseful");
    expect(p).not.toMatch(/[<>{}"\n]/);
    expect(cleanStyle("x".repeat(300))).toHaveLength(80);
    expect(cueKey(tense, "folk", "a")).not.toBe(cueKey(tense, "folk", "b"));
  });
});

describe("music director", () => {
  it("plays the first cue, keeps it while the mood holds, and changes after a calmer mood holds twice", async () => {
    const d = new MusicDirector(new MemoryFiles());
    const { src, prompts } = source([tense, tense, calm, calm]);
    expect((await d.next("a", src))?.key).toBe(cueKey(tense, "medieval folk"));
    expect(await d.next("b", src)).toBeNull();
    expect(await d.next("c", src)).toBeNull();
    expect((await d.next("d", src))?.key).toBe(cueKey(calm, "medieval folk"));
    expect(prompts).toHaveLength(2);
    expect(prompts.join(" ")).not.toMatch(/\b[abcd]\b/);
  });
  it("switches at once when the scene turns intense, and reuses cached tracks", async () => {
    const files = new MemoryFiles();
    const first = source([calm, { mood: "frantic", energy: "high" }]);
    const d = new MusicDirector(files);
    await d.next("a", first.src);
    expect((await d.next("b", first.src))?.key).toContain("frantic-high");
    const again = source([calm]);
    expect(await new MusicDirector(files).next("a", again.src)).not.toBeNull();
    expect(again.prompts).toHaveLength(0);
  });
  it("discards a clip that came back with lyrics and does not pay for it again", async () => {
    const files = new MemoryFiles();
    const d = new MusicDirector(files);
    const { src, prompts } = source([tense, tense], "Oh the river runs");
    expect(await d.next("a", src)).toBeNull();
    expect(await d.next("a", src, true)).toBeNull();
    expect(prompts).toHaveLength(1);
    expect([...files.data.keys()]).toHaveLength(0);
  });
});

describe("music director, full songs", () => {
  it("accepts section markers from the long model as instrumental", async () => {
    const { src } = source([tense], "[[A0]]\n[[B1]]\n[[C2]]");
    expect(await new MusicDirector(new MemoryFiles()).next("a", src)).not.toBeNull();
  });
});

describe("generateMusic", () => {
  it("joins streamed audio chunks, meters the cost and sends only the prompt", async () => {
    let spent = 0;
    const meter = { status: () => ({ blocked: false }), record: (u: number) => (spent += u) } as unknown as SpendMeter;
    let sent: Record<string, unknown> = {};
    const lines = [
      { choices: [{ delta: { content: "<instrumental>" } }] },
      { choices: [{ delta: { audio: { data: btoa("\x01\x02") } } }] },
      { choices: [{ delta: { audio: { data: btoa("\x03") } } }], usage: { cost: 0.04 } },
    ];
    const sse = `${lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(": OPENROUTER PROCESSING\n")}data: [DONE]\n`;
    const fetch: FetchLike = async (_u, init) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      const bytes = new TextEncoder().encode(sse);
      return { ok: true, status: 200, json: async () => ({}), body: new ReadableStream({ start: (c) => (c.enqueue(bytes.slice(0, 50)), c.enqueue(bytes.slice(50)), c.close()) }) };
    };
    const r = await generateMusic({ apiKey: "k", meter, model: "google/lyria-3-clip-preview", prompt: "Instrumental only", fetch });
    expect([...r.audio]).toEqual([1, 2, 3]);
    expect(r.text).toBe("<instrumental>");
    expect(spent).toBeCloseTo(0.04);
    expect(sent).toMatchObject({ modalities: ["text", "audio"], stream: true, messages: [{ role: "user", content: "Instrumental only" }] });
  });
});
