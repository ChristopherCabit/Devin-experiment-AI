import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TurnLog } from "../src/engine/turns.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID } from "../src/game/seeds.js";
import { seedWorld } from "../src/server/app.js";
import { SaveError, SaveManager } from "../src/server/saves.js";
import { SCHEMA_VERSION, WorldStore } from "../src/world/store.js";

/** Frozen save from format v1. Never regenerate it; add a new fixture per format version instead. */
const FIXTURE = fileURLToPath(new URL("./fixtures/save-v1.db", import.meta.url));

function mgr() {
  const dir = mkdtempSync(join(tmpdir(), "saves-"));
  const main = new Database(":memory:");
  return { dir, main, saves: new SaveManager(main, dir, seedWorld) };
}
const llm = { chat: () => Promise.resolve({ text: "<ops></ops>Fine.", promptTokens: 0, completionTokens: 0, costUsd: 0 }) };

describe("saves", () => {
  it("creates a seeded save on first use; saves are independent", async () => {
    const { saves } = mgr();
    const a = saves.active();
    expect(a.store.getEntity(PLAYER_ID)).not.toBeNull();
    await playTurn({ ...a, llm, playerId: PLAYER_ID }, "do", "go to the bar");
    const turns = a.log.lastTurn();
    const branch = saves.duplicate(a.id, "Branch");
    const second = saves.load(saves.create("Second"));
    expect(second.log.lastTurn()).toBeLessThan(turns);
    expect(saves.list().map((s) => s.name).sort()).toEqual(["Adventure", "Branch", "Second"]);
    expect(saves.load(branch).log.lastTurn()).toBe(turns);
  });

  it("deleting moves the file aside instead of erasing it", () => {
    const { saves, dir } = mgr();
    const first = saves.active().id;
    const other = saves.create("Other");
    expect(() => saves.remove(first)).toThrow(SaveError);
    saves.remove(other);
    expect(saves.list().map((s) => s.id)).toEqual([first]);
    expect(readdirSync(join(dir, "deleted")).some((f) => f.startsWith(other))).toBe(true);
  });

  it("export/import round-trips and rejects junk", () => {
    const { saves } = mgr();
    const a = saves.active();
    const n = a.store.allEntities().length;
    const id = saves.importBytes("Copy", saves.exportBytes(a.id).data);
    expect(saves.load(id).store.allEntities()).toHaveLength(n);
    expect(() => saves.importBytes("x", Buffer.from("not a database"))).toThrow(SaveError);
    expect(saves.list()).toHaveLength(2);
  });

  it("migrates the old single-file layout, keeping login and spend", () => {
    const { saves, dir, main } = mgr();
    const legacyPath = join(dir, "game.db");
    const legacy = new WorldStore(legacyPath);
    seedWorld(legacy, new TurnLog(legacy));
    legacy.db.exec(`
      CREATE TABLE credentials (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO credentials VALUES ('cred', x'00', 0, '[]', 1);
      CREATE TABLE spend (month TEXT PRIMARY KEY, usd REAL NOT NULL, calls INTEGER NOT NULL);
      INSERT INTO spend VALUES ('2026-10', 0.5, 3);
    `);
    legacy.close();
    const id = saves.migrateLegacy(legacyPath);
    expect(existsSync(legacyPath)).toBe(false);
    expect(main.prepare("SELECT count(*) AS n FROM credentials").get()).toEqual({ n: 1 });
    expect(main.prepare("SELECT usd FROM spend").get()).toEqual({ usd: 0.5 });
    const a = saves.active();
    expect(a.id).toBe(id);
    expect(a.store.getEntity(PLAYER_ID)).not.toBeNull();
    expect(a.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'credentials'").get()).toBeUndefined();
    expect(readdirSync(join(dir, "backups")).some((f) => f.startsWith("legacy-"))).toBe(true);
    expect(saves.migrateLegacy(legacyPath)).toBeNull();
  });

  it("backs up a save before upgrading its format", () => {
    const { saves, dir } = mgr();
    const id = saves.active().id;
    saves.load(saves.create("Other"));
    const db = new Database(join(dir, "saves", `${id}.db`));
    db.pragma("user_version = 0");
    db.close();
    saves.load(id);
    expect(readdirSync(join(dir, "backups")).some((f) => f.startsWith(`${id}-`) && f.endsWith("-v0.db"))).toBe(true);
  });

  it("still opens and plays the frozen v1 save, both as a file and as an import", async () => {
    for (const via of ["file", "import"] as const) {
      const { saves, dir } = mgr();
      let id: string | null;
      if (via === "file") {
        copyFileSync(FIXTURE, join(dir, "game.db"));
        id = saves.migrateLegacy(join(dir, "game.db"));
      } else {
        id = saves.importBytes("Fixture", readFileSync(FIXTURE));
      }
      const a = saves.load(id ?? "");
      expect(a.store.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(a.store.getEntity("character:mara")).not.toBeNull();
      const before = a.log.lastTurn();
      await playTurn({ ...a, llm, playerId: PLAYER_ID }, "say", "Still here?");
      expect(a.log.lastTurn()).toBe(before + 1);
      a.log.undo();
      expect(a.log.lastTurn()).toBe(before);
    }
  });
});
