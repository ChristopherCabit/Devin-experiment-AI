import { z } from "zod";
import { TurnLog } from "../engine/turns.js";
import { DEATH_POLICIES, DEFAULT_SETTINGS, getSettings, type WorldSettings } from "../game/context.js";
import { playTurn, type PlayKind, type TurnOutput } from "../game/pipeline.js";
import { PLAYER_ID, STARTER, type Seed } from "../game/seeds.js";
import { LlmClient, type ChatRequest, type ChatResult, type FetchLike } from "../llm/client.js";
import { SpendCapError, SpendMeter } from "../llm/spend.js";
import type { Files } from "../platform/files.js";
import { charProps, clockMinutes } from "../world/queries.js";
import type { Entity } from "../world/types.js";
import type { WorldStore } from "../world/store.js";
import { SaveManager, type SaveInfo } from "./saves.js";

export { SaveError } from "./saves.js";

/** A user-facing error; the message is safe to show. */
export class GameError extends Error {}

const KEY = "openrouter_key";
const CAP = "cap_usd";
const DEFAULT_CAP = 14;

const TurnBody = z.object({ kind: z.enum(["do", "say", "story", "continue"]), input: z.string().max(2000).default("") });
const EntityBody = z.object({
  name: z.string().min(1).max(80).optional(),
  aliases: z.array(z.string().min(1).max(80)).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
const CreateBody = z.object({
  kind: z.enum(["room", "container", "item", "character", "place", "region"]),
  name: z.string().min(1).max(80),
  parent: z.string().optional(),
  zone: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
const SettingsBody = z
  .object({
    title: z.string().max(120),
    premise: z.string().max(8000),
    style: z.string().max(2000),
    intensity: z.enum(["none", "mild", "explicit"]),
    limits: z.string().max(2000),
    deathPolicy: z.enum(DEATH_POLICIES),
    narratorModel: z.string().min(1).max(120),
    parserModel: z.string().min(1).max(120),
    contextTokens: z.number().int().min(4000).max(128000),
  })
  .partial();
const ConfigBody = z.object({ apiKey: z.string().max(400).nullable().optional(), capUsd: z.number().min(0).max(1000).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new GameError("invalid input");
  return r.data;
}

export function seedWorld(store: WorldStore, log: TurnLog, seed: Seed = STARTER): void {
  store.db.exec("DELETE FROM entities; DELETE FROM facts; DELETE FROM meta; DELETE FROM turns;");
  store.setMeta("settings", { ...DEFAULT_SETTINGS, ...seed.settings });
  const { results } = log.commit({ kind: "author", input: "new world", ops: seed.ops, source: "author" });
  const bad = results.find((r) => !r.ok);
  if (bad && !bad.ok) throw new Error(`seed failed: ${bad.reason}`);
  log.commit({ kind: "system", input: "", output: seed.opening, ops: [], source: "engine" });
}

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };

export interface GameOptions {
  files: Files;
  fetch?: FetchLike;
  /** Replaces the OpenRouter client (tests). */
  llm?: (meter: SpendMeter) => Llm;
}

export type GameState = ReturnType<Game["state"]>;

/**
 * The whole app behind one object: engine, saves, spend cap and settings. Runs on the device;
 * the only network traffic is model calls to OpenRouter. Every mutation runs one at a time and is written to disk before it resolves.
 */
export class Game {
  private busy: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly saves: SaveManager,
    readonly meter: SpendMeter,
    private readonly opts: GameOptions,
  ) {}

  static async open(opts: GameOptions): Promise<Game> {
    const saves = await SaveManager.open(opts.files, seedWorld);
    await saves.ensureActive();
    const cap = Number(saves.getMeta(CAP) ?? DEFAULT_CAP);
    return new Game(saves, new SpendMeter(saves.main, Number.isFinite(cap) ? cap : DEFAULT_CAP), opts);
  }

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = async () => {
      try {
        return await fn();
      } finally {
        await this.saves.flush();
      }
    };
    const next = this.busy.then(run, run);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private get W() {
    return this.saves.active();
  }

  private llm(): Llm {
    if (this.opts.llm) return this.opts.llm(this.meter);
    const apiKey = this.saves.getMeta(KEY);
    if (!apiKey) throw new GameError("Add your OpenRouter API key in World → App settings.");
    return new LlmClient({ apiKey, meter: this.meter, fetch: this.opts.fetch });
  }

  state() {
    const { store, log } = this.W;
    const player = store.getEntity(PLAYER_ID);
    const p = player ? charProps(player) : null;
    const here = player?.parent_id ? store.getEntity(player.parent_id) : null;
    return {
      settings: getSettings(store),
      clock: clockMinutes(store),
      location: here?.name ?? null,
      zone: p?.scene.zone ?? null,
      sheet: p?.sheet ?? null,
      conditions: (player?.props.conditions as string[] | undefined) ?? [],
      turns: log
        .history(60)
        .filter((t) => t.kind !== "author")
        .map((t) => ({ n: t.n, kind: t.kind, input: t.input, output: t.output })),
      spend: this.meter.status(),
      save: this.saves.activeInfo(),
      hasKey: Boolean(this.saves.getMeta(KEY)),
    };
  }

  // --- app settings ---
  config(): { hasKey: boolean; capUsd: number } {
    return { hasKey: Boolean(this.saves.getMeta(KEY)), capUsd: this.meter.capUsd };
  }

  setConfig(body: unknown): Promise<{ hasKey: boolean; capUsd: number }> {
    const b = parse(ConfigBody, body);
    return this.serial(() => {
      if (b.apiKey !== undefined) this.saves.setMeta(KEY, b.apiKey?.trim() || null);
      if (b.capUsd !== undefined) {
        this.saves.setMeta(CAP, String(b.capUsd));
        this.meter.capUsd = b.capUsd;
      }
      return this.config();
    });
  }

  // --- play ---
  private play(run: () => Promise<TurnOutput>): Promise<TurnOutput & { state: GameState }> {
    if (this.meter.status().blocked) return Promise.reject(new SpendCapError());
    return this.serial(async () => ({ ...(await run()), state: this.state() }));
  }

  turn(kind: PlayKind, input: string): Promise<TurnOutput & { state: GameState }> {
    const b = parse(TurnBody, { kind, input });
    return this.play(() => {
      const llm = this.llm();
      return playTurn({ ...this.W, llm, playerId: PLAYER_ID }, b.kind, b.input ?? "");
    });
  }

  private undoAllowed() {
    return getSettings(this.W.store).deathPolicy !== "ironman";
  }

  undo(): Promise<GameState> {
    return this.serial(() => {
      const last = this.W.log.history(1)[0];
      if (!this.undoAllowed()) throw new GameError("undo disabled (ironman)");
      if (!last || last.kind === "author" || last.n <= 2) throw new GameError("nothing to undo");
      this.W.log.undo();
      return this.state();
    });
  }

  retry(): Promise<TurnOutput & { state: GameState }> {
    const last = this.W.log.history(1)[0];
    if (!this.undoAllowed()) return Promise.reject(new GameError("retry disabled (ironman)"));
    if (!last || !["do", "say", "story", "continue"].includes(last.kind)) return Promise.reject(new GameError("nothing to retry"));
    const { kind, input } = last;
    return this.play(() => {
      const llm = this.llm();
      this.W.log.undo();
      return playTurn({ ...this.W, llm, playerId: PLAYER_ID }, kind as PlayKind, input);
    });
  }

  // --- author mode ---
  entities(): Entity[] {
    return this.W.store.allEntities();
  }

  updateEntity(id: string, body: unknown): Promise<Entity | null> {
    const b = parse(EntityBody, body);
    return this.serial(() => {
      const { results } = this.W.log.commit({ kind: "author", input: `edit ${id}`, source: "author", ops: [{ op: "author_update", id, ...b }] });
      const r = results[0];
      if (!r?.ok) throw new GameError(r && !r.ok ? r.reason : "failed");
      return this.W.store.getEntity(id);
    });
  }

  createEntity(body: unknown): Promise<Entity | null> {
    const b = parse(CreateBody, body);
    return this.serial(() => {
      const { results } = this.W.log.commit({ kind: "author", input: `create ${b.name}`, source: "author", ops: [{ op: "create_entity", ...b }] });
      const r = results[0];
      if (!r?.ok) throw new GameError(r && !r.ok ? r.reason : "failed");
      return this.W.store.getEntity(r.id ?? "");
    });
  }

  settings(): WorldSettings {
    return getSettings(this.W.store);
  }

  updateSettings(body: unknown): Promise<WorldSettings> {
    const b = parse(SettingsBody, body);
    return this.serial(() => {
      const next: WorldSettings = { ...getSettings(this.W.store), ...b };
      this.W.store.setMeta("settings", next);
      return next;
    });
  }

  // --- saves ---
  listSaves(): SaveInfo[] {
    return this.saves.list();
  }

  newSave(name: string): Promise<GameState> {
    return this.serial(async () => {
      await this.saves.load(await this.saves.create(name || "New adventure"));
      return this.state();
    });
  }

  loadSave(id: string): Promise<GameState> {
    return this.serial(async () => {
      await this.saves.load(id);
      return this.state();
    });
  }

  duplicateSave(id: string, name: string): Promise<string> {
    return this.serial(() => this.saves.duplicate(id, name));
  }

  renameSave(id: string, name: string): Promise<void> {
    return this.serial(() => this.saves.rename(id, name));
  }

  deleteSave(id: string): Promise<void> {
    return this.serial(() => this.saves.remove(id));
  }

  exportSave(id: string): Promise<{ name: string; data: Uint8Array }> {
    return this.serial(() => this.saves.exportBytes(id));
  }

  importSave(name: string, data: Uint8Array): Promise<string> {
    return this.serial(() => this.saves.importBytes(name, data));
  }
}
