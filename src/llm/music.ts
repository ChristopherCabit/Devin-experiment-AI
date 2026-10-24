import { LlmError, type FetchLike } from "./client.js";
import { SpendCapError, type SpendMeter } from "./spend.js";

export interface MusicOptions {
  apiKey: string;
  meter: SpendMeter;
  model: string;
  prompt: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface MusicResult {
  audio: Uint8Array;
  /** What the model says alongside the audio; Lyria answers "<instrumental>" or the lyrics it sang. */
  text: string;
  costUsd: number;
}

type AudioChunk = { choices?: { delta?: { content?: string; audio?: { data?: string } } }[]; usage?: { cost?: number }; error?: { code?: unknown } };

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Generates one music clip through OpenRouter. Only the prompt is sent; prompt and audio are kept in memory and never logged. */
export async function generateMusic(o: MusicOptions): Promise<MusicResult> {
  if (o.meter.status().blocked) throw new SpendCapError();
  const f = o.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
  const res = await f(`${o.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: o.model, modalities: ["text", "audio"], stream: true, provider: { data_collection: "deny" }, messages: [{ role: "user", content: o.prompt }] }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 240_000),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
    throw new LlmError(res.status, String(body.error?.code ?? "error"));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parts: Uint8Array[] = [];
  let buf = "";
  let text = "";
  let costUsd = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: AudioChunk;
      try {
        chunk = JSON.parse(data) as AudioChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new LlmError(200, String(chunk.error.code ?? "error"));
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      if (delta?.audio?.data) parts.push(b64(delta.audio.data));
      if (chunk.usage?.cost !== undefined) costUsd = chunk.usage.cost;
    }
    if (done) break;
  }
  o.meter.record(costUsd);
  const size = parts.reduce((n, p) => n + p.length, 0);
  if (!size) throw new LlmError(200, "no_audio");
  const audio = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    audio.set(p, at);
    at += p.length;
  }
  return { audio, text, costUsd };
}
