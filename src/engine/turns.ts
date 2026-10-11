import { applyOps, type Limits, type OpResult } from "../ops/apply.js";
import type { OpSource } from "../ops/schema.js";
import type { Change, WorldStore } from "../world/store.js";

export type TurnKind = "do" | "say" | "story" | "continue" | "author" | "system";

export interface TurnRecord {
  n: number;
  kind: TurnKind;
  source: OpSource;
  input: string;
  ops: unknown[];
  results: { op: string; ok: boolean; reason?: string; note?: string }[];
  changes: Change[];
  created_at: number;
}

interface TurnRow {
  n: number;
  kind: string;
  source: string;
  input: string;
  ops: string;
  results: string;
  changes: string;
  created_at: number;
}

function rowToRecord(row: TurnRow): TurnRecord {
  return {
    n: row.n,
    kind: row.kind as TurnKind,
    source: row.source as OpSource,
    input: row.input,
    ops: JSON.parse(row.ops),
    results: JSON.parse(row.results),
    changes: JSON.parse(row.changes),
    created_at: row.created_at,
  };
}

function opName(raw: unknown): string {
  return typeof raw === "object" && raw !== null && "op" in raw ? String(raw.op) : "?";
}

/** Append-only turn log. Each turn stores row-level diffs, so undo is exact. */
export class TurnLog {
  constructor(private readonly store: WorldStore) {}

  lastTurn(): number {
    const { n } = this.store.db.prepare("SELECT coalesce(max(n), 0) AS n FROM turns").get() as { n: number };
    return n;
  }

  commit(args: {
    kind: TurnKind;
    input: string;
    ops: readonly unknown[];
    source: OpSource;
    limits?: Partial<Limits>;
  }): { turn: number; results: OpResult[] } {
    const n = this.lastTurn() + 1;
    this.store.beginCapture();
    try {
      return this.store.transaction(() => {
        const results = applyOps(this.store, args.ops, { source: args.source, turn: n, limits: args.limits });
        const changes = this.store.endCapture();
        const summary = results.map((r) =>
          r.ok ? { op: r.op.op, ok: true, ...(r.note ? { note: r.note } : {}) } : { op: opName(r.op), ok: false, reason: r.reason },
        );
        this.store.db
          .prepare(
            `INSERT INTO turns (n, kind, source, input, ops, results, changes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(n, args.kind, args.source, args.input, JSON.stringify(args.ops), JSON.stringify(summary), JSON.stringify(changes), Date.now());
        return { turn: n, results };
      });
    } finally {
      this.store.abortCapture();
    }
  }

  /** Reverts and removes the latest turn. Returns it, or null if the log is empty. */
  undo(): TurnRecord | null {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM turns ORDER BY n DESC LIMIT 1").get() as TurnRow | undefined;
      if (!row) return null;
      const rec = rowToRecord(row);
      this.store.revert(rec.changes);
      this.store.db.prepare("DELETE FROM turns WHERE n = ?").run(rec.n);
      return rec;
    });
  }

  /** Undo for regeneration: the caller re-runs the returned input. */
  retry(): Pick<TurnRecord, "kind" | "input" | "source"> | null {
    const rec = this.undo();
    return rec ? { kind: rec.kind, input: rec.input, source: rec.source } : null;
  }

  history(limit = 50): TurnRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM turns ORDER BY n DESC LIMIT ?").all(limit) as TurnRow[];
    return rows.map(rowToRecord).reverse();
  }
}
