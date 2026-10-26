import { Db } from "../db/sqlite.js";
import { TurnLog } from "../engine/turns.js";
import type { Files } from "../platform/files.js";
import { SCHEMA_VERSION, WorldStore } from "../world/store.js";

export class SaveError extends Error {}

export interface SaveInfo {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  active: boolean;
}

export interface ActiveSave {
  id: string;
  store: WorldStore;
  log: TurnLog;
}

type SaveRow = Omit<SaveInfo, "active">;

const MAIN = "main.db";
const ID = /^[a-f0-9]{16}$/;
const KEEP_BACKUPS = 5;
/** Tables and columns copied out of an imported file; nothing else in it is ever read. */
const COLUMNS: Record<string, readonly string[]> = {
  entities: ["id", "kind", "name", "aliases", "parent_id", "props", "created_turn"],
  facts: ["id", "text", "subjects", "turn"],
  meta: ["key", "value"],
  turns: ["n", "kind", "source", "input", "ops", "results", "changes", "output", "created_at"],
};

const cleanName = (s: string): string => s.replace(/\p{Cc}/gu, "").trim().slice(0, 80) || "Untitled";
const newId = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * One SQLite file per scenario under `saves/`, plus `main.db` (save index, spend, app settings).
 * Saves are never erased by the app: deletes move files to `deleted/`, and every format upgrade first copies the file to `backups/`.
 * Databases live in memory; `flush()` writes them out.
 */
export class SaveManager {
  private current: ActiveSave | null = null;

  private constructor(
    readonly main: Db,
    private readonly files: Files,
    private readonly seed: (store: WorldStore, log: TurnLog) => void,
    private readonly now: () => number,
  ) {}

  static async open(files: Files, seed: (store: WorldStore, log: TurnLog) => void, now: () => number = Date.now): Promise<SaveManager> {
    for (const d of ["saves", "backups", "deleted"]) await files.mkdir(d);
    const main = Db.open((await files.read(MAIN)) ?? undefined);
    main.exec(`
      CREATE TABLE IF NOT EXISTS saves (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    return new SaveManager(main, files, seed, now);
  }

  getMeta(key: string): string | null {
    return ((this.main.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value) ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.main.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
    else this.main.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new SaveError("no such save");
    return `saves/${id}.db`;
  }

  private need(id: string): SaveRow {
    this.file(id);
    const row = this.main.prepare("SELECT id, name, created_at, updated_at FROM saves WHERE id = ?").get(id) as SaveRow | undefined;
    if (!row) throw new SaveError("no such save");
    return row;
  }

  private register(id: string, name: string): void {
    const t = this.now();
    this.main.prepare("INSERT INTO saves (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, cleanName(name), t, t);
  }

  list(): SaveInfo[] {
    const rows = this.main.prepare("SELECT id, name, created_at, updated_at FROM saves ORDER BY updated_at DESC").all() as unknown as SaveRow[];
    return rows.map((r) => ({ ...r, active: r.id === this.current?.id }));
  }

  active(): ActiveSave {
    if (!this.current) throw new Error("no save loaded");
    return this.current;
  }

  /** Loads the last active save, or the newest one, creating a starter save if there are none. */
  async ensureActive(): Promise<ActiveSave> {
    if (this.current) return this.current;
    const want = this.getMeta("active");
    const ids = this.list().map((s) => s.id);
    return this.load(want && ids.includes(want) ? want : (ids[0] ?? (await this.create("Adventure"))));
  }

  activeInfo(): { id: string; name: string } {
    const { id, name } = this.need(this.active().id);
    return { id, name };
  }

  async load(id: string): Promise<ActiveSave> {
    this.need(id);
    if (this.current?.id === id) return this.current;
    const bytes = await this.files.read(this.file(id));
    if (!bytes) throw new SaveError("save file is missing");
    const store = await this.openStore(id, bytes);
    this.current?.store.close();
    this.current = { id, store, log: new TurnLog(store) };
    this.setMeta("active", id);
    await this.flushMain();
    return this.current;
  }

  /** Opens save bytes, first copying them to backups if the format is about to be upgraded. */
  private async openStore(id: string, bytes: Uint8Array): Promise<WorldStore> {
    let version: number;
    try {
      const probe = Db.open(bytes);
      version = probe.pragma("user_version");
      probe.close();
    } catch {
      throw new SaveError("save file is damaged");
    }
    if (version > SCHEMA_VERSION) throw new SaveError("this save is from a newer version of the app");
    if (version < SCHEMA_VERSION) await this.backup(id, `v${version}`, bytes);
    return new WorldStore(bytes);
  }

  async backup(id: string, tag: string, bytes: Uint8Array): Promise<string> {
    const dest = `backups/${id}-${this.now()}-${tag}.db`;
    await this.files.write(dest, bytes);
    const mine = (await this.files.list("backups")).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".db")).sort();
    for (const f of mine.slice(0, -KEEP_BACKUPS)) await this.files.remove(`backups/${f}`);
    return dest;
  }

  async create(name: string, seed: (store: WorldStore, log: TurnLog) => void = this.seed): Promise<string> {
    const id = newId();
    const store = new WorldStore();
    try {
      seed(store, new TurnLog(store));
      await this.files.write(this.file(id), store.serialize());
    } finally {
      store.close();
    }
    this.register(id, name);
    await this.flushMain();
    return id;
  }

  private async bytes(id: string): Promise<Uint8Array> {
    this.need(id);
    if (this.current?.id === id) return this.current.store.serialize();
    const b = await this.files.read(this.file(id));
    if (!b) throw new SaveError("save file is missing");
    return b;
  }

  async duplicate(id: string, name: string): Promise<string> {
    const data = await this.bytes(id);
    const copy = newId();
    await this.files.write(this.file(copy), data);
    this.register(copy, name);
    await this.flushMain();
    return copy;
  }

  async rename(id: string, name: string): Promise<void> {
    this.need(id);
    this.main.prepare("UPDATE saves SET name = ? WHERE id = ?").run(cleanName(name), id);
    await this.flushMain();
  }

  async remove(id: string): Promise<void> {
    this.need(id);
    if (this.current?.id === id) throw new SaveError("load another save before deleting this one");
    await this.files.rename(this.file(id), `deleted/${id}-${this.now()}.db`);
    this.main.prepare("DELETE FROM saves WHERE id = ?").run(id);
    await this.flushMain();
  }

  /** Writes the active save and main.db to disk. */
  async flush(): Promise<void> {
    if (this.current) {
      await this.files.write(this.file(this.current.id), this.current.store.serialize());
      this.main.prepare("UPDATE saves SET updated_at = ? WHERE id = ?").run(this.now(), this.current.id);
    }
    await this.flushMain();
  }

  async flushMain(): Promise<void> {
    await this.files.write(MAIN, this.main.serialize());
  }

  async exportBytes(id: string): Promise<{ name: string; data: Uint8Array }> {
    return { name: this.need(id).name, data: await this.bytes(id) };
  }

  /** Copies known tables/columns from an imported file into a fresh save; the file itself never becomes a save. */
  async importBytes(name: string, data: Uint8Array): Promise<string> {
    let src: Db | null = null;
    let dest: WorldStore | null = null;
    try {
      let version: number;
      let tables: Set<string>;
      try {
        src = Db.open(data);
        version = src.pragma("user_version");
        tables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      } catch {
        throw new SaveError("not a save file");
      }
      if (version > SCHEMA_VERSION) throw new SaveError("this save is from a newer version of the app");
      if (!tables.has("entities") || !tables.has("turns")) throw new SaveError("not a save file");
      const from = src;
      const to = (dest = new WorldStore());
      try {
        to.transaction(() => {
          for (const [table, cols] of Object.entries(COLUMNS)) {
            if (!tables.has(table)) continue;
            const have = new Set((from.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
            const use = cols.filter((c) => have.has(c));
            const insert = to.db.prepare(`INSERT INTO ${table} (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
            for (const row of from.prepare(`SELECT ${use.join(", ")} FROM ${table}`).rows()) insert.run(...row);
          }
        });
        to.allEntities();
      } catch {
        throw new SaveError("save file is damaged or incompatible");
      }
      const id = newId();
      await this.files.write(this.file(id), to.serialize());
      this.register(id, name);
      await this.flushMain();
      return id;
    } finally {
      src?.close();
      dest?.close();
    }
  }
}
