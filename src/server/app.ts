import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { TurnLog } from "../engine/turns.js";
import { DEATH_POLICIES, DEFAULT_SETTINGS, getSettings, type WorldSettings } from "../game/context.js";
import { playTurn, type PlayKind } from "../game/pipeline.js";
import { PLAYER_ID, STARTER, type Seed } from "../game/seeds.js";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import { SpendCapError, type SpendMeter } from "../llm/spend.js";
import { charProps, clockMinutes } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import { Auth, CHALLENGE_COOKIE, SESSION_COOKIE } from "./auth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const WEBAUTHN_BUNDLE = join(ROOT, "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");

export interface AppConfig {
  store: WorldStore;
  meter: SpendMeter;
  llm: { chat(req: ChatRequest): Promise<ChatResult> };
  origin: string;
  setupCode: string;
  /** Metadata-only access log sink (method, route, status, ms). Never receives bodies. */
  accessLog?: (line: string) => void;
}

/** Routes reachable without a session. Everything else is denied by default. */
const PUBLIC_ROUTES = new Set([
  "GET /",
  "GET /app.js",
  "GET /style.css",
  "GET /manifest.json",
  "GET /webauthn.js",
  "GET /healthz",
  "GET /auth/status",
  "POST /auth/register/options",
  "POST /auth/register/verify",
  "POST /auth/login/options",
  "POST /auth/login/verify",
]);

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

export function seedWorld(store: WorldStore, log: TurnLog, seed: Seed = STARTER): void {
  store.db.exec("DELETE FROM entities; DELETE FROM facts; DELETE FROM meta; DELETE FROM turns;");
  store.setMeta("settings", { ...DEFAULT_SETTINGS, ...seed.settings });
  const { results } = log.commit({ kind: "author", input: "new world", ops: seed.ops, source: "author" });
  const bad = results.find((r) => !r.ok);
  if (bad && !bad.ok) throw new Error(`seed failed: ${bad.reason}`);
  log.commit({ kind: "system", input: "", output: seed.opening, ops: [], source: "engine" });
}

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const { store, meter, llm } = cfg;
  const url = new URL(cfg.origin);
  const secure = url.protocol === "https:";
  const auth = new Auth(store.db, url.hostname, cfg.origin, cfg.setupCode);
  const log = new TurnLog(store);
  if (!store.getEntity(PLAYER_ID)) seedWorld(store, log);

  // Requests are logged by our own metadata-only hook; Fastify's logger is off so bodies can never be logged.
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, serve: false });

  const cookieOpts = { path: "/", httpOnly: true, secure, sameSite: "strict" as const };
  const sid = (req: FastifyRequest) => req.cookies[SESSION_COOKIE];
  const loggedIn = (req: FastifyRequest) => auth.validSession(sid(req));
  const authBuckets = new Map<string, { n: number; reset: number }>();

  app.addHook("onRequest", async (req, reply) => {
    (req as FastifyRequest & { t0: number }).t0 = performance.now();
    const route = `${req.method === "HEAD" ? "GET" : req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== cfg.origin) {
      return reply.code(403).send({ error: "bad origin" });
    }
    if (route.startsWith("POST /auth/")) {
      const now = Date.now();
      const b = authBuckets.get(req.ip) ?? { n: 0, reset: now + 10 * 60 * 1000 };
      if (now > b.reset) Object.assign(b, { n: 0, reset: now + 10 * 60 * 1000 });
      b.n++;
      authBuckets.set(req.ip, b);
      if (b.n > 30) return reply.code(429).send({ error: "rate limited" });
    }
    if (!PUBLIC_ROUTES.has(route) && !loggedIn(req)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (secure) reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const ms = Math.round(performance.now() - ((req as FastifyRequest & { t0?: number }).t0 ?? 0));
    cfg.accessLog?.(`${req.method} ${req.routeOptions.url ?? "unmatched"} ${reply.statusCode} ${ms}ms`);
  });

  const page = (file: string, type: string) => (_: FastifyRequest, reply: FastifyReply) => reply.type(type).sendFile(file);
  app.get("/", page("index.html", "text/html; charset=utf-8"));
  app.get("/app.js", page("app.js", "text/javascript"));
  app.get("/style.css", page("style.css", "text/css"));
  app.get("/manifest.json", page("manifest.json", "application/manifest+json"));
  const bundle = readFileSync(WEBAUTHN_BUNDLE);
  app.get("/webauthn.js", (_, reply) => reply.type("text/javascript").send(bundle));
  app.get("/healthz", () => ({ ok: true }));

  // --- auth ---
  app.get("/auth/status", (req) => ({ loggedIn: loggedIn(req), registered: auth.hasCredentials(), locked: auth.locked() }));
  app.post("/auth/register/options", async (req, reply) => {
    const code = (req.body as { setupCode?: unknown } | undefined)?.setupCode;
    if (!auth.canRegister(typeof code === "string" ? code : undefined, loggedIn(req))) return reply.code(403).send({ error: "registration closed" });
    const { options, challengeId } = await auth.registrationOptions();
    reply.setCookie(CHALLENGE_COOKIE, challengeId, { ...cookieOpts, maxAge: 300 });
    return options;
  });
  app.post("/auth/register/verify", async (req, reply) => {
    if (auth.hasCredentials() && !loggedIn(req)) return reply.code(403).send({ error: "registration closed" });
    const ok = await auth.verifyRegistration(req.body as never, req.cookies[CHALLENGE_COOKIE]);
    reply.clearCookie(CHALLENGE_COOKIE, cookieOpts);
    if (!ok) return reply.code(400).send({ error: "registration failed" });
    const s = auth.createSession();
    reply.setCookie(SESSION_COOKIE, s.id, { ...cookieOpts, maxAge: s.maxAgeSec });
    return { ok: true };
  });
  app.post("/auth/login/options", async (_req, reply) => {
    if (auth.locked()) return reply.code(429).send({ error: "locked" });
    const { options, challengeId } = await auth.authenticationOptions();
    reply.setCookie(CHALLENGE_COOKIE, challengeId, { ...cookieOpts, maxAge: 300 });
    return options;
  });
  app.post("/auth/login/verify", async (req, reply) => {
    const ok = await auth.verifyAuthentication(req.body as never, req.cookies[CHALLENGE_COOKIE]);
    reply.clearCookie(CHALLENGE_COOKIE, cookieOpts);
    if (!ok) return reply.code(401).send({ error: "login failed" });
    const s = auth.createSession();
    reply.setCookie(SESSION_COOKIE, s.id, { ...cookieOpts, maxAge: s.maxAgeSec });
    return { ok: true };
  });
  app.post("/auth/logout", (req, reply) => {
    auth.endSession(sid(req));
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  // --- game ---
  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = busy.then(fn, fn);
    busy = next.catch(() => undefined);
    return next;
  };

  const state = () => {
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
      spend: meter.status(),
    };
  };

  app.get("/api/state", () => state());
  app.post("/api/turn", async (req, reply) => {
    const body = TurnBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    if (meter.status().blocked) return reply.code(402).send({ error: new SpendCapError().message });
    try {
      const out = await serial(() => playTurn({ store, log, llm, playerId: PLAYER_ID }, body.data.kind as PlayKind, body.data.input));
      return { ...out, state: state() };
    } catch (e) {
      if (e instanceof SpendCapError) return reply.code(402).send({ error: e.message });
      return reply.code(502).send({ error: e instanceof Error && e.name === "LlmError" ? e.message : "turn failed" });
    }
  });
  const undoAllowed = () => getSettings(store).deathPolicy !== "ironman";
  const lastPlayable = () => log.history(1)[0];
  app.post("/api/undo", (_req, reply) =>
    serial(() => {
      const last = lastPlayable();
      if (!undoAllowed()) return reply.code(409).send({ error: "undo disabled (ironman)" });
      if (!last || last.kind === "author" || last.n <= 2) return reply.code(409).send({ error: "nothing to undo" });
      log.undo();
      return state();
    }),
  );
  app.post("/api/retry", async (_req, reply) => {
    const last = lastPlayable();
    if (!undoAllowed()) return reply.code(409).send({ error: "retry disabled (ironman)" });
    if (!last || !["do", "say", "story", "continue"].includes(last.kind)) return reply.code(409).send({ error: "nothing to retry" });
    if (meter.status().blocked) return reply.code(402).send({ error: new SpendCapError().message });
    try {
      const out = await serial(() => {
        log.undo();
        return playTurn({ store, log, llm, playerId: PLAYER_ID }, last.kind as PlayKind, last.input);
      });
      return { ...out, state: state() };
    } catch (e) {
      if (e instanceof SpendCapError) return reply.code(402).send({ error: e.message });
      return reply.code(502).send({ error: "turn failed" });
    }
  });

  // --- author mode ---
  app.get("/api/entities", () => store.allEntities());
  app.put("/api/entities/:id", (req, reply) => {
    const body = EntityBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    const id = (req.params as { id: string }).id;
    const { results } = log.commit({ kind: "author", input: `edit ${id}`, source: "author", ops: [{ op: "author_update", id, ...body.data }] });
    const r = results[0];
    return r?.ok ? store.getEntity(id) : reply.code(400).send({ error: r && !r.ok ? r.reason : "failed" });
  });
  app.post("/api/entities", (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    const { results } = log.commit({ kind: "author", input: `create ${body.data.name}`, source: "author", ops: [{ op: "create_entity", ...body.data }] });
    const r = results[0];
    return r?.ok ? store.getEntity(r.id ?? "") : reply.code(400).send({ error: r && !r.ok ? r.reason : "failed" });
  });
  app.get("/api/settings", () => getSettings(store));
  app.put("/api/settings", (req, reply) => {
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    const next: WorldSettings = { ...getSettings(store), ...body.data };
    store.setMeta("settings", next);
    return next;
  });
  app.post("/api/world/new", (req, reply) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) return reply.code(400).send({ error: "confirm required" });
    return serial(() => {
      seedWorld(store, log);
      return state();
    });
  });

  return app;
}
