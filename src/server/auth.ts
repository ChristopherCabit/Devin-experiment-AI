import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type Database from "better-sqlite3";

export const SESSION_COOKIE = "__Host-sid";
export const CHALLENGE_COOKIE = "__Host-chal";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function codesMatch(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return b.length > 0 && timingSafeEqual(x, y);
}

/** Passkey-only auth for a single user. Session ids are stored hashed. */
export class Auth {
  private readonly challenges = new Map<string, { challenge: string; expires: number }>();
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly rpId: string,
    private readonly origin: string,
    private readonly setupCode: string,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    `);
  }

  hasCredentials(): boolean {
    return (this.db.prepare("SELECT count(*) AS n FROM credentials").get() as { n: number }).n > 0;
  }

  locked(): boolean {
    return this.now() < this.lockedUntil;
  }

  private fail(): void {
    this.failures++;
    if (this.failures >= 5) {
      this.lockedUntil = this.now() + 15 * 60 * 1000;
      this.failures = 0;
    }
  }

  private putChallenge(challenge: string): string {
    for (const [k, v] of this.challenges) if (v.expires < this.now()) this.challenges.delete(k);
    const id = randomBytes(24).toString("base64url");
    this.challenges.set(id, { challenge, expires: this.now() + CHALLENGE_TTL_MS });
    return id;
  }

  private takeChallenge(id: string | undefined): string | null {
    if (!id) return null;
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    return c && c.expires >= this.now() ? c.challenge : null;
  }

  /** Registration needs the setup code while no passkey exists, or an active session afterwards. */
  canRegister(code: string | undefined, loggedIn: boolean): boolean {
    if (loggedIn) return true;
    if (this.hasCredentials() || this.locked()) return false;
    if (code && codesMatch(code, this.setupCode)) return true;
    this.fail();
    return false;
  }

  async registrationOptions() {
    const existing = this.db.prepare("SELECT id, transports FROM credentials").all() as { id: string; transports: string }[];
    const options = await generateRegistrationOptions({
      rpName: "Adventure",
      rpID: this.rpId,
      userName: "player",
      userID: new TextEncoder().encode("player"),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    });
    return { options, challengeId: this.putChallenge(options.challenge) };
  }

  async verifyRegistration(response: RegistrationResponseJSON, challengeId: string | undefined): Promise<boolean> {
    const expectedChallenge = this.takeChallenge(challengeId);
    if (!expectedChallenge) return false;
    try {
      const r = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
      if (!r.verified) return false;
      const c = r.registrationInfo.credential;
      this.db
        .prepare("INSERT INTO credentials (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(c.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), this.now());
      return true;
    } catch {
      return false;
    }
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: "required" });
    return { options, challengeId: this.putChallenge(options.challenge) };
  }

  async verifyAuthentication(response: AuthenticationResponseJSON, challengeId: string | undefined): Promise<boolean> {
    if (this.locked()) return false;
    const expectedChallenge = this.takeChallenge(challengeId);
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(response.id) as
      | { id: string; public_key: Buffer; counter: number; transports: string }
      | undefined;
    if (!expectedChallenge || !row) {
      this.fail();
      return false;
    }
    try {
      const r = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
      });
      if (!r.verified) {
        this.fail();
        return false;
      }
      this.db.prepare("UPDATE credentials SET counter = ? WHERE id = ?").run(r.authenticationInfo.newCounter, row.id);
      this.failures = 0;
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  createSession(): { id: string; maxAgeSec: number } {
    const id = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO sessions (id_hash, expires) VALUES (?, ?)").run(hash(id), this.now() + SESSION_TTL_MS);
    return { id, maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  validSession(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.db.prepare("SELECT expires FROM sessions WHERE id_hash = ?").get(hash(id)) as { expires: number } | undefined;
    return !!row && row.expires > this.now();
  }

  endSession(id: string | undefined): void {
    if (id) this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hash(id));
  }
}
