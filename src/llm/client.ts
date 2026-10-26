import { SpendCapError, type SpendMeter } from "./spend.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  /** Tools the model may call mid-generation; each call is answered by onTool and the generation continues. */
  tools?: ToolDef[];
  onTool?: (name: string, args: string) => Promise<string> | string;
  /** Most tool calls answered per request (default 2); after that the model must finish without them. */
  maxToolCalls?: number;
  /** "required" forces a tool call in the first round only; later rounds are "auto", and the last "none". */
  toolChoice?: "auto" | "none" | "required";
  /** Stops a streamed generation early; the call then rejects with LlmAborted. */
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Which upstream provider served it (metadata only). */
  provider?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
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

/** A generation stopped by the caller. Its cost is looked up afterwards and recorded on the meter; `cost` resolves to it. */
export class LlmAborted extends Error {
  constructor(readonly cost: Promise<number>) {
    super("llm request aborted");
  }
}

export interface EmbedResult {
  vectors: number[][];
  costUsd: number;
}

interface StreamChunk {
  id?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: CompletionBody["usage"];
  provider?: string;
  error?: { code?: string | number };
}

interface CompletionBody {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  provider?: string;
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
      ...(req.tools?.length ? { tools: req.tools.map((f) => ({ type: "function", function: f })), tool_choice: req.toolChoice ?? "auto" } : {}),
      ...(req.web ? { plugins: [{ id: "web", engine: "exa", max_results: req.web }] } : {}),
      provider: { zdr: true, data_collection: "deny" },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const onTool = req.onTool;
    if (!req.tools?.length || !onTool) {
      const r = await this.once(req);
      return { text: r.text, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costUsd: r.costUsd };
    }
    const max = req.maxToolCalls ?? 2;
    const messages = [...req.messages];
    const out: ChatResult = { text: "", promptTokens: 0, completionTokens: 0, costUsd: 0 };
    let calls = 0;
    let draft = "";
    for (;;) {
      const last = calls >= max;
      const choice = last ? "none" : calls === 0 && req.toolChoice === "required" ? "required" : "auto";
      const r = await this.once({ ...req, messages, toolChoice: choice, ...(req.onText ? { onText: req.onText } : {}) });
      out.promptTokens += r.promptTokens;
      out.completionTokens += r.completionTokens;
      out.costUsd += r.costUsd;
      if (r.provider) out.provider = r.provider;
      if (!r.toolCalls.length || last) {
        out.text = r.text.trim() ? r.text : draft;
        return out;
      }
      // A draft written alongside a lookup is superseded by the passage written after it.
      if (r.text.trim().length > draft.trim().length) draft = r.text;
      messages.push({ role: "assistant", content: r.text, tool_calls: r.toolCalls });
      for (const tc of r.toolCalls) {
        calls++;
        const answer = calls > max ? "Lookup limit reached for this passage; write it now with what you have." : await onTool(tc.function.name, tc.function.arguments);
        messages.push({ role: "tool", tool_call_id: tc.id, content: answer });
      }
    }
  }

  private async once(req: ChatRequest): Promise<ChatResult & { toolCalls: ToolCall[] }> {
    if (this.opts.meter.status().blocked) throw new SpendCapError();
    const sent = LlmClient.requestBody(req);
    const triedOff = (sent.reasoning as { enabled?: boolean } | undefined)?.enabled === false;
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(sent),
      signal: req.signal ? anySignal(req.signal, AbortSignal.timeout(this.timeoutMs)) : AbortSignal.timeout(this.timeoutMs),
    }).catch((e: unknown) => {
      if (req.signal?.aborted) throw new LlmAborted(Promise.resolve(0));
      throw e;
    });
    if (req.onText && res.ok && res.body) return this.readStream(req.onText, res.body, req.signal);
    const body = (await res.json().catch(() => ({}))) as CompletionBody;
    if (res.status === 400 && triedOff && /reasoning is mandatory/i.test(String(body.error?.message))) {
      LlmClient.mandatoryReasoning.add(req.model);
      return this.once(req);
    }
    if (!res.ok || body.error) throw new LlmError(res.status, String(body.error?.code ?? "error"));
    const text = body.choices?.[0]?.message?.content ?? "";
    const costUsd = body.usage?.cost ?? 0;
    this.opts.meter.record(costUsd);
    return {
      text,
      toolCalls: body.choices?.[0]?.message?.tool_calls ?? [],
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd,
      ...(body.provider ? { provider: body.provider } : {}),
    };
  }

  /** Reads an SSE completion. Chunks are only accumulated in memory, never logged. */
  private async readStream(onText: (sofar: string) => void, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<ChatResult & { toolCalls: ToolCall[] }> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let usage: CompletionBody["usage"] = {};
    const calls: ToolCall[] = [];
    let provider = "";
    let id = "";
    for (;;) {
      if (signal?.aborted) {
        void reader.cancel().catch(() => undefined);
        throw new LlmAborted(this.lateCost(id));
      }
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw new LlmAborted(this.lateCost(id));
        throw e;
      }
      const { done, value } = step;
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
        if (chunk.id) id = chunk.id;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(text);
        }
        for (const d of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          const tc = (calls[d.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (d.id) tc.id = d.id;
          if (d.function?.name) tc.function.name += d.function.name;
          if (d.function?.arguments) tc.function.arguments += d.function.arguments;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.provider) provider = chunk.provider;
      }
      if (signal?.aborted) {
        void reader.cancel().catch(() => undefined);
        throw new LlmAborted(this.lateCost(id));
      }
      if (done) break;
    }
    const costUsd = usage?.cost ?? 0;
    this.opts.meter.record(costUsd);
    return { text, toolCalls: calls.filter(Boolean), promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0, costUsd, ...(provider ? { provider } : {}) };
  }

  /** What a stopped generation cost (generation stats, metadata only), recorded on the meter once known. */
  private async lateCost(id: string): Promise<number> {
    if (!id) return 0;
    for (const wait of [800, 1500, 3000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/generation?id=${encodeURIComponent(id)}`, { method: "GET", headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const cost = Number(((await res.json()) as { data?: { total_cost?: unknown } }).data?.total_cost ?? NaN);
        if (Number.isFinite(cost)) {
          this.opts.meter.record(cost);
          return cost;
        }
      } catch {
        /* try again */
      }
    }
    return 0;
  }

  /** Embeds texts through a zero-retention provider. Only vectors come back; nothing is logged. */
  async embed(model: string, texts: string[], dimensions: number, timeoutMs = this.timeoutMs): Promise<EmbedResult> {
    const out: EmbedResult = { vectors: [], costUsd: 0 };
    for (let k = 0; k < texts.length; k += 64) {
      if (this.opts.meter.status().blocked) throw new SpendCapError();
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
                // Measured: DeepInfra answers in ~0.3 s, others take 1-9 s; any zero-retention provider is a fallback.
        body: JSON.stringify({ model, input: texts.slice(k, k + 64), dimensions, provider: { zdr: true, data_collection: "deny", order: ["deepinfra", "siliconflow"], allow_fallbacks: true } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: { embedding?: number[] }[]; usage?: { cost?: number }; error?: { code?: string | number } };
      if (!res.ok || body.error || body.data?.length !== Math.min(64, texts.length - k)) throw new LlmError(res.status, String(body.error?.code ?? "embed"));
      const cost = body.usage?.cost ?? 0;
      this.opts.meter.record(cost);
      out.costUsd += cost;
      for (const d of body.data) out.vectors.push(d.embedding ?? []);
    }
    return out;
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) c.abort();
    else s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}
