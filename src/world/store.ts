import Database from "better-sqlite3";
import { Entity, Fact, type EntityKind } from "./types.js";

export type Table = "entities" | "facts" | "meta";

/** Row-level before/after images, used for turn diffs and undo. */
export interface Change {
  table: Table;
  key: string;
  before: unknown;
  after: unknown;
}

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  aliases: string;
  parent_id: string | null;
  props: string;
  created_turn: number;
}

interface FactRow {
  id: number;
  text: string;
  subjects: string;
  turn: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  parent_id TEXT,
  props TEXT NOT NULL,
  created_turn INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entities_parent ON entities(parent_id);
CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  subjects TEXT NOT NULL,
  turn INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  n INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  input TEXT NOT NULL,
  ops TEXT NOT NULL,
  results TEXT NOT NULL,
  changes TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

/** Save-format version. To change the format, append a migration; never edit an existing one. Migrations only add. */
export const SCHEMA_VERSION = 1;
const MIGRATIONS: ((db: Database.Database) => void)[] = [(db) => db.exec(SCHEMA)];

function rowToEntity(row: EntityRow): Entity {
  return Entity.parse({
    ...row,
    aliases: JSON.parse(row.aliases),
    props: JSON.parse(row.props),
  });
}

function entityToRow(e: Entity): EntityRow {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: JSON.stringify(e.aliases),
    parent_id: e.parent_id,
    props: JSON.stringify(e.props),
    created_turn: e.created_turn,
  };
}

function rowToFact(row: FactRow): Fact {
  return Fact.parse({ ...row, subjects: JSON.parse(row.subjects) });
}

export class WorldStore {
  readonly db: Database.Database;
  private capture: Map<string, Change> | null = null;
  private readonly stmts = new Map<string, Database.Statement>();

  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new Error(`save format v${version} is newer than this app (v${SCHEMA_VERSION})`);
    this.db.transaction(() => {
      for (let v = version; v < SCHEMA_VERSION; v++) MIGRATIONS[v]?.(this.db);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` atomically. Nested calls become savepoints. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  getEntity(id: string): Entity | null {
    const row = this.stmt("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  putEntity(e: Entity): void {
    const parsed = Entity.parse(e);
    this.touch("entities", parsed.id);
    this.writeEntityRow(entityToRow(parsed));
  }

  deleteEntity(id: string): void {
    this.touch("entities", id);
    this.stmt("DELETE FROM entities WHERE id = ?").run(id);
  }

  children(parentId: string): Entity[] {
    const rows = this.stmt("SELECT * FROM entities WHERE parent_id = ? ORDER BY id").all(parentId) as EntityRow[];
    return rows.map(rowToEntity);
  }

  entitiesOfKind(kind: EntityKind): Entity[] {
    const rows = this.stmt("SELECT * FROM entities WHERE kind = ? ORDER BY id").all(kind) as EntityRow[];
    return rows.map(rowToEntity);
  }

  allEntities(): Entity[] {
    const rows = this.stmt("SELECT * FROM entities ORDER BY id").all() as EntityRow[];
    return rows.map(rowToEntity);
  }

  addFact(text: string, subjects: string[], turn: number): number {
    const { next } = this.stmt("SELECT coalesce(max(id), 0) + 1 AS next FROM facts").get() as { next: number };
    this.touch("facts", String(next));
    this.stmt("INSERT INTO facts (id, text, subjects, turn) VALUES (?, ?, ?, ?)").run(
      next,
      text,
      JSON.stringify(subjects),
      turn,
    );
    return next;
  }

  facts(): Fact[] {
    const rows = this.stmt("SELECT * FROM facts ORDER BY id").all() as FactRow[];
    return rows.map(rowToFact);
  }

  getMeta<T>(key: string, fallback: T): T {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setMeta(key: string, value: unknown): void {
    this.touch("meta", key);
    this.stmt("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  beginCapture(): void {
    if (this.capture) throw new Error("capture already active");
    this.capture = new Map();
  }

  /** Ends capture and returns the rows that actually changed. */
  endCapture(): Change[] {
    if (!this.capture) throw new Error("no active capture");
    const changes = [...this.capture.values()]
      .map((c) => ({ ...c, after: this.readRaw(c.table, c.key) }))
      .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
    this.capture = null;
    return changes;
  }

  abortCapture(): void {
    this.capture = null;
  }

  /** Restores the `before` image of each change, newest first. */
  revert(changes: readonly Change[]): void {
    if (this.capture) throw new Error("cannot revert while capturing");
    for (const c of [...changes].reverse()) this.writeRaw(c.table, c.key, c.before);
  }

  private touch(table: Table, key: string): void {
    if (!this.capture) return;
    const k = `${table}:${key}`;
    if (!this.capture.has(k)) {
      this.capture.set(k, { table, key, before: this.readRaw(table, key), after: null });
    }
  }

  private readRaw(table: Table, key: string): unknown {
    switch (table) {
      case "entities":
        return this.stmt("SELECT * FROM entities WHERE id = ?").get(key) ?? null;
      case "facts":
        return this.stmt("SELECT * FROM facts WHERE id = ?").get(Number(key)) ?? null;
      case "meta":
        return this.stmt("SELECT * FROM meta WHERE key = ?").get(key) ?? null;
    }
  }

  private writeRaw(table: Table, key: string, row: unknown): void {
    switch (table) {
      case "entities":
        if (row === null) this.stmt("DELETE FROM entities WHERE id = ?").run(key);
        else this.writeEntityRow(row as EntityRow);
        return;
      case "facts":
        if (row === null) this.stmt("DELETE FROM facts WHERE id = ?").run(Number(key));
        else this.stmt("INSERT OR REPLACE INTO facts (id, text, subjects, turn) VALUES (@id, @text, @subjects, @turn)").run(row);
        return;
      case "meta":
        if (row === null) this.stmt("DELETE FROM meta WHERE key = ?").run(key);
        else this.stmt("INSERT OR REPLACE INTO meta (key, value) VALUES (@key, @value)").run(row);
        return;
    }
  }

  private writeEntityRow(row: EntityRow): void {
    this.stmt(
      `INSERT OR REPLACE INTO entities (id, kind, name, aliases, parent_id, props, created_turn)
       VALUES (@id, @kind, @name, @aliases, @parent_id, @props, @created_turn)`,
    ).run(row);
  }
}
