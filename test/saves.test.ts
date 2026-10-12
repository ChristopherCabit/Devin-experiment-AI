import { readFileSync } from "node:fs";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seedWorld } from "../src/app/game.js";
import { SaveError, SaveManager } from "../src/app/saves.js";
import { Db } from "../src/db/sqlite.js";
import { playTurn } from "../src/game/pipeline.js";
import { PLAYER_ID } from "../src/game/seeds.js";
import { NodeFiles } from "../src/platform/node-files.js";
import { SCHEMA_VERSION } from "../src/world/store.js";

/** Frozen save from format v1. Never regenerate it; add a new fixture per format version instead. */
const FIXTURE = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/save-v1.db", import.meta.url))));

async function mgr() {
  const dir = mkdtempSync(join(tmpdir(), "saves-"));
  const files = new NodeFiles(dir);
  return { dir, files, saves: await SaveManager.open(files, seedWorld) };
}
const llm = { chat: () => Promise.resolve({ text: "<ops></ops>Fine.", promptTokens: 0, completionTokens: 0, costUsd: 0 }) };

describe("saves", () => {
  it("creates a seeded save on first use; saves are independent", async () => {
    const { saves } = await mgr();
    const a = await saves.ensureActive();
    expect(a.store.getEntity(PLAYER_ID)).not.toBeNull();
    await playTurn({ ...a, llm, playerId: PLAYER_ID }, "do", "go to the bar");
    const turns = a.log.lastTurn();
    const branch = await saves.duplicate(a.id, "Branch");
    const second = await saves.load(await saves.create("Second"));
    expect(second.log.lastTurn()).toBeLessThan(turns);
    expect(saves.list().map((s) => s.name).sort()).toEqual(["Adventure", "Branch", "Second"]);
    expect((await saves.load(branch)).log.lastTurn()).toBe(turns);
  });

  it("persists to disk and reopens where it left off", async () => {
    const { files, saves } = await mgr();
    const a = await saves.ensureActive();
    await playTurn({ ...a, llm, playerId: PLAYER_ID }, "say", "hello");
    const n = a.log.lastTurn();
    await saves.flush();
    const again = await SaveManager.open(files, seedWorld);
    const b = await again.ensureActive();
    expect(b.id).toBe(a.id);
    expect(b.log.lastTurn()).toBe(n);
  });

  it("deleting moves the file aside instead of erasing it", async () => {
    const { saves, dir } = await mgr();
    const first = (await saves.ensureActive()).id;
    const other = await saves.create("Other");
    await expect(saves.remove(first)).rejects.toThrow(SaveError);
    await saves.remove(other);
    expect(saves.list().map((s) => s.id)).toEqual([first]);
    expect(readdirSync(join(dir, "deleted")).some((f) => f.startsWith(other))).toBe(true);
  });

  it("export/import round-trips and rejects junk", async () => {
    const { saves } = await mgr();
    const a = await saves.ensureActive();
    const n = a.store.allEntities().length;
    const id = await saves.importBytes("Copy", (await saves.exportBytes(a.id)).data);
    expect((await saves.load(id)).store.allEntities()).toHaveLength(n);
    await expect(saves.importBytes("x", new TextEncoder().encode("not a database"))).rejects.toThrow(SaveError);
    expect(saves.list()).toHaveLength(2);
  });

  it("backs up a save before upgrading its format", async () => {
    const { saves, files, dir } = await mgr();
    const id = (await saves.ensureActive()).id;
    await saves.load(await saves.create("Other"));
    const db = Db.open((await files.read(`saves/${id}.db`))!);
    db.exec("PRAGMA user_version = 0");
    await files.write(`saves/${id}.db`, db.serialize());
    db.close();
    await saves.load(id);
    expect(readdirSync(join(dir, "backups")).some((f) => f.startsWith(`${id}-`) && f.endsWith("-v0.db"))).toBe(true);
  });

  it("refuses saves from a newer app version", async () => {
    const { saves } = await mgr();
    const db = Db.open(FIXTURE);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(saves.importBytes("Future", db.serialize())).rejects.toThrow(/newer version/);
    db.close();
  });

  it("still opens and plays the frozen v1 save, both as a file and as an import", async () => {
    for (const via of ["file", "import"] as const) {
      const { saves, files } = await mgr();
      let id: string;
      if (via === "file") {
        id = await saves.create("Fixture");
        await files.write(`saves/${id}.db`, FIXTURE);
      } else {
        id = await saves.importBytes("Fixture", FIXTURE);
      }
      const a = await saves.load(id);
      expect(a.store.db.pragma("user_version")).toBe(SCHEMA_VERSION);
      expect(a.store.getEntity("character:mara")).not.toBeNull();
      const before = a.log.lastTurn();
      await playTurn({ ...a, llm, playerId: PLAYER_ID }, "say", "Still here?");
      expect(a.log.lastTurn()).toBe(before + 1);
      a.log.undo();
      expect(a.log.lastTurn()).toBe(before);
    }
  });

  it("opens files written in WAL mode (exports from the old server)", async () => {
    const { saves } = await mgr();
    const wal = new Uint8Array(FIXTURE);
    wal[18] = wal[19] = 2;
    const a = await saves.load(await saves.importBytes("Old export", wal));
    expect(a.store.getEntity("character:mara")).not.toBeNull();
  });
});
