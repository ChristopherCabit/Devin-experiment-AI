import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type WasmDb = InstanceType<Sqlite3["oo1"]["DB"]>;
type WasmStmt = ReturnType<WasmDb["prepare"]>;
type Row = Record<string, unknown>;

let lib: Sqlite3 | null = null;

/** Loads the SQLite WebAssembly module. Call once before opening any database. */
export async function initSqlite(): Promise<void> {
  // SQLite's own diagnostics include SQL text; keep them off the console.
  lib ??= await (sqlite3InitModule as (o: object) => ReturnType<typeof sqlite3InitModule>)({ print: () => {}, printErr: () => {} });
}

function sqlite(): Sqlite3 {
  if (!lib) throw new Error("initSqlite() has not been awaited");
  return lib;
}

const isNamed = (p: unknown[]): p is [Row] =>
  p.length === 1 && typeof p[0] === "object" && p[0] !== null && !Array.isArray(p[0]) && !(p[0] instanceof Uint8Array);

/** A cached prepared statement with a better-sqlite3-style surface (get/all/rows/run). */
export class Statement {
  constructor(private readonly s: WasmStmt) {}

  private bound(params: unknown[]): WasmStmt {
    this.s.reset(true);
    if (isNamed(params)) {
      const named: Row = {};
      for (const [k, v] of Object.entries(params[0])) named[`@${k}`] = v ?? null;
      this.s.bind(named as never);
    } else if (params.length) {
      this.s.bind(params.map((v) => v ?? null) as never);
    }
    return this.s;
  }

  get(...params: unknown[]): Row | undefined {
    const s = this.bound(params);
    try {
      return s.step() ? (s.get({}) as Row) : undefined;
    } finally {
      s.reset();
    }
  }

  all(...params: unknown[]): Row[] {
    const s = this.bound(params);
    const out: Row[] = [];
    try {
      while (s.step()) out.push(s.get({}) as Row);
    } finally {
      s.reset();
    }
    return out;
  }

  /** Rows as positional arrays. */
  rows(...params: unknown[]): unknown[][] {
    const s = this.bound(params);
    const out: unknown[][] = [];
    try {
      while (s.step()) out.push(s.get([]) as unknown[]);
    } finally {
      s.reset();
    }
    return out;
  }

  run(...params: unknown[]): void {
    const s = this.bound(params);
    try {
      s.step();
    } finally {
      s.reset();
    }
  }

  finalize(): void {
    this.s.finalize();
  }
}

/** In-memory SQLite database. Persistence is the caller's job: `serialize()` the bytes and write them out. */
export class Db {
  private readonly stmts = new Map<string, Statement>();
  private depth = 0;

  private constructor(private readonly db: WasmDb) {}

  /** Opens an empty database, or a copy of `bytes` (a whole SQLite file). */
  static open(bytes?: Uint8Array): Db {
    const s = sqlite();
    const db = new s.oo1.DB(":memory:");
    if (bytes?.byteLength) {
      const copy = new Uint8Array(bytes);
      // Files written in WAL mode (header bytes 18-19 = 2) can't be opened from memory; the bytes are self-contained.
      if (copy[18] === 2) copy[18] = copy[19] = 1;
      const p = s.wasm.allocFromTypedArray(copy);
      const flags = s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE;
      const rc = s.capi.sqlite3_deserialize(db.pointer as never, "main", p, copy.byteLength, copy.byteLength, flags);
      if (rc) {
        db.close();
        throw new Error(`not a database (${rc})`);
      }
    }
    const out = new Db(db);
    try {
      out.exec("PRAGMA trusted_schema = OFF");
      out.pragma("schema_version");
    } catch (e) {
      out.close();
      throw e;
    }
    return out;
  }

  prepare(sql: string): Statement {
    let st = this.stmts.get(sql);
    if (!st) {
      st = new Statement(this.db.prepare(sql));
      this.stmts.set(sql, st);
    }
    return st;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(name: string): number {
    return Number(this.db.selectValue(`PRAGMA ${name}`) ?? 0);
  }

  /** Runs `fn` atomically. Nested calls become nested savepoints. */
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.depth++}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  serialize(): Uint8Array {
    return sqlite().capi.sqlite3_js_db_export(this.db as never);
  }

  close(): void {
    for (const s of this.stmts.values()) s.finalize();
    this.stmts.clear();
    this.db.close();
  }
}
