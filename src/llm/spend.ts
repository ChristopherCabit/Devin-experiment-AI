import type Database from "better-sqlite3";

/**
 * Monthly spend ledger. Kept outside the turn-diff tables so undo never
 * refunds money that was actually spent.
 */
export class SpendMeter {
  constructor(
    private readonly db: Database.Database,
    readonly capUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS spend (month TEXT PRIMARY KEY, usd REAL NOT NULL, calls INTEGER NOT NULL)");
  }

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  spentThisMonth(): number {
    const row = this.db.prepare("SELECT usd FROM spend WHERE month = ?").get(this.month()) as { usd: number } | undefined;
    return row?.usd ?? 0;
  }

  record(usd: number): void {
    this.db
      .prepare(
        `INSERT INTO spend (month, usd, calls) VALUES (?, ?, 1)
         ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      )
      .run(this.month(), usd);
  }

  status(): { spent: number; cap: number; warn: boolean; blocked: boolean } {
    const spent = this.spentThisMonth();
    return { spent, cap: this.capUsd, warn: spent >= this.capUsd * 0.8, blocked: spent >= this.capUsd };
  }
}

export class SpendCapError extends Error {
  constructor() {
    super("monthly spend cap reached");
  }
}
