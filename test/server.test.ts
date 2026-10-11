import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp, seedWorld } from "../src/server/app.js";
import { SaveManager } from "../src/server/saves.js";
import { SpendMeter } from "../src/llm/spend.js";
import type { ChatRequest } from "../src/llm/client.js";

const ORIGIN = "https://adv.example.com";

async function setup() {
  const mainDb = new Database(":memory:");
  const saves = new SaveManager(mainDb, mkdtempSync(join(tmpdir(), "srv-")), seedWorld);
  const store = saves.active().store;
  const meter = new SpendMeter(mainDb, 0.2);
  const lines: string[] = [];
  // Mirrors LlmClient: every call is recorded on the meter.
  const llm = {
    chat: (req: ChatRequest) => {
      const costUsd = req.maxTokens > 0 ? 0.01 : 0;
      meter.record(costUsd);
      return Promise.resolve({ text: "<ops></ops>SECRET STORY TEXT", promptTokens: 1, completionTokens: 1, costUsd });
    },
  };
  const app = await buildApp({ mainDb, saves, meter, llm, origin: ORIGIN, setupCode: "correct horse", accessLog: (l) => lines.push(l) });
  return { app, store, mainDb, meter, lines };
}

describe("server", () => {
  it("denies every non-public route without a session", async () => {
    const { app } = await setup();
    const routes = app.printRoutes({ commonPrefix: false });
    const protectedRoutes: [string, string][] = [
      ["GET", "/api/state"],
      ["POST", "/api/turn"],
      ["POST", "/api/undo"],
      ["POST", "/api/retry"],
      ["GET", "/api/entities"],
      ["PUT", "/api/entities/character:you"],
      ["POST", "/api/entities"],
      ["GET", "/api/settings"],
      ["PUT", "/api/settings"],
      ["POST", "/api/world/new"],
      ["GET", "/api/saves"],
      ["POST", "/api/saves"],
      ["POST", "/api/saves/0123456789abcdef/load"],
      ["POST", "/api/saves/0123456789abcdef/duplicate"],
      ["PUT", "/api/saves/0123456789abcdef"],
      ["DELETE", "/api/saves/0123456789abcdef"],
      ["GET", "/api/saves/0123456789abcdef/export"],
      ["POST", "/api/saves/import"],
      ["POST", "/auth/logout"],
      ["GET", "/nonexistent"],
    ];
    for (const [method, url] of protectedRoutes) {
      const r = await app.inject({ method: method as "GET", url, headers: { origin: ORIGIN }, payload: method === "GET" ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(routes).toMatch(/api\/turn/);
  });

  it("serves the shell with hardened headers", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/api/state" })).statusCode).toBe(401);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["strict-transport-security"]).toMatch(/max-age/);
    expect(String(r.headers["content-security-policy"])).toMatch(/frame-ancestors 'none'/);
  });

  it("rejects cross-origin writes and wrong setup codes", async () => {
    const { app } = await setup();
    const evil = await app.inject({ method: "POST", url: "/auth/register/options", headers: { origin: "https://evil.example" }, payload: { setupCode: "correct horse" } });
    expect(evil.statusCode).toBe(403);
    const wrong = await app.inject({ method: "POST", url: "/auth/register/options", headers: { origin: ORIGIN }, payload: { setupCode: "nope" } });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/auth/register/options", headers: { origin: ORIGIN }, payload: { setupCode: "correct horse" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rp.id).toBe("adv.example.com");
    expect(String(ok.headers["set-cookie"])).toMatch(/__Host-chal=.*HttpOnly.*Secure.*SameSite=Strict/);
  });

  it("locks registration after repeated bad codes", async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/auth/register/options", headers: { origin: ORIGIN }, payload: { setupCode: "x" } });
    }
    const r = await app.inject({ method: "POST", url: "/auth/register/options", headers: { origin: ORIGIN }, payload: { setupCode: "correct horse" } });
    expect(r.statusCode).toBe(403);
  });

  it("plays turns with a session, never logs bodies, and enforces the spend cap", async () => {
    const { app, mainDb, lines } = await setup();
    const { Auth, SESSION_COOKIE } = await import("../src/server/auth.js");
    const s = new Auth(mainDb, "adv.example.com", ORIGIN, "x").createSession();
    const headers = { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${s.id}` };
    const state = await app.inject({ method: "GET", url: "/api/state", headers });
    expect(state.statusCode).toBe(200);
    expect(state.json().turns[0].output).toMatch(/Lantern Inn/);
    for (let i = 0; i < 50; i++) {
      const r = await app.inject({ method: "POST", url: "/api/turn", headers, payload: { kind: "say", input: "PRIVATE PLAYER TEXT" } });
      if (r.statusCode === 402) break;
      expect(r.statusCode).toBe(200);
    }
    const capped = await app.inject({ method: "POST", url: "/api/turn", headers, payload: { kind: "say", input: "hi" } });
    expect(capped.statusCode).toBe(402);
    const undo = await app.inject({ method: "POST", url: "/api/undo", headers, payload: {} });
    expect(undo.statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/PRIVATE|SECRET|Lantern/);
  });
});
