import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TurnLog } from "../engine/turns.js";
import { SCHEMA_VERSION, WorldStore } from "../world/store.js";

export class SaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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

const ID = /^[a-f0-9]{16}$/;
const KEEP_BACKUPS = 5;
/** Tables and columns copied out of an imported file; nothing else in it is ever read. */
const COLUMNS: Record<string, readonly string[]> = {
  entities: ["id", "kind", "name", "aliases", "parent_id", "props", "created_turn"],
  facts: ["id", "text", "subjects", "turn"],
  meta: ["key", "value"],
  turns: ["n", "kind", "source", "input", "ops", "results", "changes", "output", "created_at"],
};
/** App-level tables that lived inside the world file before saves existed. */
const LEGACY_APP_TABLES = ["credentials", "sessions", "spend"];

const cleanName = (s: string): string => s.replace(/\p{Cc}/gu, "").trim().slice(0, 80) || "Untitled";

const copyWithWal = (src: string, dest: string): void => {
  copyFileSync(src, dest);
  if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${dest}-wal`);
};

/**
 * One SQLite file per scenario under `<dir>/saves`. Saves are never erased by the app:
 * deletes move files to `<dir>/deleted`, and every format upgrade first copies the file to `<dir>/backups`.
 */
export class SaveManager {
  private current: ActiveSave | null = null;

  constructor(
    private readonly main: Database.Database,
    private readonly dir: string,
    private readonly seed: (store: WorldStore, log: TurnLog) => void,
    private readonly now: () => number = Date.now,
  ) {
    for (const d of ["saves", "backups", "deleted", "tmp"]) mkdirSync(join(dir, d), { recursive: true });
    main.exec(`
      CREATE TABLE IF NOT EXISTS saves (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new SaveError(404, "no such save");
    return join(this.dir, "saves", `${id}.db`);
  }

  private need(id: string): SaveRow {
    const row = this.main.prepare("SELECT id, name, created_at, updated_at FROM saves WHERE id = ?").get(id) as SaveRow | undefined;
    if (!row || !existsSync(this.file(id))) throw new SaveError(404, "no such save");
    return row;
  }

  private newId(): string {
    return randomBytes(8).toString("hex");
  }

  private register(id: string, name: string): void {
    const t = this.now();
    this.main.prepare("INSERT INTO saves (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, cleanName(name), t, t);
  }

  list(): SaveInfo[] {
    const rows = this.main.prepare("SELECT id, name, created_at, updated_at FROM saves ORDER BY updated_at DESC").all() as SaveRow[];
    return rows.map((r) => ({ ...r, active: r.id === this.current?.id }));
  }

  active(): ActiveSave {
    if (this.current) return this.current;
    const want = (this.main.prepare("SELECT value FROM app_meta WHERE key = 'active'").get() as { value: string } | undefined)?.value;
    const ids = this.list().map((s) => s.id);
    return this.load(want && ids.includes(want) ? want : (ids[0] ?? this.create("Adventure")));
  }

  activeInfo(): { id: string; name: string } {
    const { id, name } = this.need(this.active().id);
    return { id, name };
  }

  load(id: string): ActiveSave {
    this.need(id);
    if (this.current?.id === id) return this.current;
    const store = this.open(id);
    this.current?.store.close();
    this.current = { id, store, log: new TurnLog(store) };
    this.main
      .prepare("INSERT INTO app_meta (key, value) VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(id);
    return this.current;
  }

  /** Opens a save, copying it to backups first if its format is about to be upgraded. */
  private open(id: string): WorldStore {
    const path = this.file(id);
    const probe = new Database(path, { fileMustExist: true });
    const version = probe.pragma("user_version", { simple: true }) as number;
    probe.close();
    if (version > SCHEMA_VERSION) throw new SaveError(409, "this save is from a newer version of the app");
    if (version < SCHEMA_VERSION) this.backup(id, `v${version}`);
    return new WorldStore(path);
  }

  backup(id: string, tag: string): string {
    const dest = join(this.dir, "backups", `${id}-${this.now()}-${tag}.db`);
    if (this.current?.id === id) writeFileSync(dest, this.current.store.db.serialize());
    else copyWithWal(this.file(id), dest);
    const mine = readdirSync(join(this.dir, "backups"))
      .filter((f) => f.startsWith(`${id}-`) && f.endsWith(".db"))
      .sort();
    for (const f of mine.slice(0, -KEEP_BACKUPS)) {
      rmSync(join(this.dir, "backups", f));
      rmSync(join(this.dir, "backups", `${f}-wal`), { force: true });
    }
    return dest;
  }

  create(name: string): string {
    const id = this.newId();
    const store = new WorldStore(this.file(id));
    try {
      this.seed(store, new TurnLog(store));
    } finally {
      store.close();
    }
    this.register(id, name);
    return id;
  }

  private bytes(id: string): Buffer {
    this.need(id);
    if (this.current?.id === id) return this.current.store.db.serialize();
    const db = new Database(this.file(id), { fileMustExist: true });
    try {
      return db.serialize();
    } finally {
      db.close();
    }
  }

  duplicate(id: string, name: string): string {
    const data = this.bytes(id);
    const copy = this.newId();
    writeFileSync(this.file(copy), data);
    this.register(copy, name);
    return copy;
  }

  rename(id: string, name: string): void {
    this.need(id);
    this.main.prepare("UPDATE saves SET name = ? WHERE id = ?").run(cleanName(name), id);
  }

  remove(id: string): void {
    this.need(id);
    if (this.current?.id === id) throw new SaveError(409, "load another save before deleting this one");
    const src = this.file(id);
    const dest = join(this.dir, "deleted", `${id}-${this.now()}.db`);
    renameSync(src, dest);
    if (existsSync(`${src}-wal`)) renameSync(`${src}-wal`, `${dest}-wal`);
    rmSync(`${src}-shm`, { force: true });
    this.main.prepare("DELETE FROM saves WHERE id = ?").run(id);
  }

  touch(): void {
    if (this.current) this.main.prepare("UPDATE saves SET updated_at = ? WHERE id = ?").run(this.now(), this.current.id);
  }

  exportBytes(id: string): { name: string; data: Buffer } {
    return { name: this.need(id).name, data: this.bytes(id) };
  }

  /** Copies known tables/columns from an uploaded file into a fresh save; the upload itself never becomes a save. */
  importBytes(name: string, data: Buffer): string {
    const tmp = join(this.dir, "tmp", `${this.newId()}.db`);
    const id = this.newId();
    writeFileSync(tmp, data);
    let src: Database.Database | null = null;
    let dest: WorldStore | null = null;
    try {
      let version: number;
      let tables: Set<string>;
      try {
        src = new Database(tmp, { fileMustExist: true });
        src.pragma("trusted_schema = OFF");
        version = src.pragma("user_version", { simple: true }) as number;
        tables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      } catch {
        throw new SaveError(400, "not a save file");
      }
      if (version > SCHEMA_VERSION) throw new SaveError(409, "this save is from a newer version of the app");
      if (!tables.has("entities") || !tables.has("turns")) throw new SaveError(400, "not a save file");
      const from = src;
      const to = (dest = new WorldStore(this.file(id)));
      try {
        to.transaction(() => {
          for (const [table, cols] of Object.entries(COLUMNS)) {
            if (!tables.has(table)) continue;
            const have = new Set((from.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
            const use = cols.filter((c) => have.has(c));
            const insert = to.db.prepare(`INSERT INTO ${table} (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
            for (const row of from.prepare(`SELECT ${use.join(", ")} FROM ${table}`).raw().iterate() as Iterable<unknown[]>) insert.run(...row);
          }
        });
        to.allEntities();
      } catch {
        throw new SaveError(400, "save file is damaged or incompatible");
      }
      dest.close();
      dest = null;
      this.register(id, name);
      return id;
    } catch (e) {
      dest?.close();
      for (const s of ["", "-wal", "-shm"]) rmSync(`${this.file(id)}${s}`, { force: true });
      throw e;
    } finally {
      src?.close();
      for (const s of ["", "-wal", "-shm"]) rmSync(`${tmp}${s}`, { force: true });
    }
  }

  /** One-time move from the original single-file layout (world + login + spend in one db) to per-save files. */
  migrateLegacy(path: string): string | null {
    if (!existsSync(path) || this.list().length) return null;
    copyWithWal(path, join(this.dir, "backups", `legacy-${this.now()}.db`));
    const legacy = new WorldStore(path);
    let title = "Adventure";
    try {
      const settings = legacy.db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string } | undefined;
      const t = settings ? (JSON.parse(settings.value) as { title?: unknown }).title : undefined;
      if (typeof t === "string" && t.trim()) title = t;
      for (const table of LEGACY_APP_TABLES) {
        const ddl = (legacy.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
        if (!ddl) continue;
        if (!this.main.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) this.main.exec(ddl);
        for (const row of legacy.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
          const cols = Object.keys(row);
          this.main.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
        }
        legacy.db.exec(`DROP TABLE ${table}`);
      }
    } finally {
      legacy.close();
    }
    const id = this.newId();
    renameSync(path, this.file(id));
    for (const s of ["-wal", "-shm"]) rmSync(`${path}${s}`, { force: true });
    this.register(id, title);
    return id;
  }
}
