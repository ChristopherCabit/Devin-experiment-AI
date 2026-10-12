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

interface CompletionBody {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: string | number };
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

  static requestBody(req: ChatRequest): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.8,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      provider: { zdr: true, data_collection: "deny" },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.opts.meter.status().blocked) throw new SpendCapError();
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(LlmClient.requestBody(req)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as CompletionBody;
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
}
