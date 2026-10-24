import { SpendCapError, type SpendMeter } from "./spend.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  json?: boolean;
  /** Hidden reasoning tokens cost latency; "off" falls back to "low" on models where reasoning is mandatory. */
  reasoning?: "off" | "low" | "default";
  /** Stream the completion, called with the text so far as it arrives. */
  onText?: (sofar: string) => void;
  /** Ground the answer in this many web search results (OpenRouter web plugin, Exa). */
  web?: number;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export interface LlmClientOptions {
  apiKey: string;
  meter: SpendMeter;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Thrown with metadata only; request and response bodies are never included. */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`llm request failed: ${status} ${code}`);
  }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: CompletionBody["usage"];
  error?: { code?: string | number };
}

interface CompletionBody {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: string | number; message?: string };
}

/**
 * OpenRouter client. Every request pins zero-data-retention routing and
 * denies providers that collect data; nothing here logs prompts or completions.
 */
export class LlmClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: LlmClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    // Bound: WebViews throw "Illegal invocation" when fetch is called detached from window.
    this.fetchImpl = opts.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  /** Models observed to reject disabling reasoning. */
  static readonly mandatoryReasoning = new Set<string>();

  static requestBody(req: ChatRequest): Record<string, unknown> {
    let mode = req.reasoning ?? "off";
    if (mode === "off" && LlmClient.mandatoryReasoning.has(req.model)) mode = "low";
    return {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.8,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(mode === "off" ? { reasoning: { enabled: false } } : mode === "low" ? { reasoning: { effort: "low" } } : {}),
      ...(req.onText ? { stream: true } : {}),
      ...(req.web ? { plugins: [{ id: "web", engine: "exa", max_results: req.web }] } : {}),
      provider: { zdr: true, data_collection: "deny" },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.opts.meter.status().blocked) throw new SpendCapError();
    const sent = LlmClient.requestBody(req);
    const triedOff = (sent.reasoning as { enabled?: boolean } | undefined)?.enabled === false;
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(sent),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (req.onText && res.ok && res.body) return this.readStream(req.onText, res.body);
    const body = (await res.json().catch(() => ({}))) as CompletionBody;
    if (res.status === 400 && triedOff && /reasoning is mandatory/i.test(String(body.error?.message))) {
      LlmClient.mandatoryReasoning.add(req.model);
      return this.chat(req);
    }
    if (!res.ok || body.error) throw new LlmError(res.status, String(body.error?.code ?? "error"));
    const text = body.choices?.[0]?.message?.content ?? "";
    const costUsd = body.usage?.cost ?? 0;
    this.opts.meter.record(costUsd);
    return {
      text,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd,
    };
  }

  /** Reads an SSE completion. Chunks are only accumulated in memory, never logged. */
  private async readStream(onText: (sofar: string) => void, stream: ReadableStream<Uint8Array>): Promise<ChatResult> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let usage: CompletionBody["usage"] = {};
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
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new LlmError(200, String(chunk.error.code ?? "error"));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(text);
        }
        if (chunk.usage) usage = chunk.usage;
      }
      if (done) break;
    }
    const costUsd = usage?.cost ?? 0;
    this.opts.meter.record(costUsd);
    return { text, promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0, costUsd };
  }
}
