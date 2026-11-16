import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { OpInput } from "../ops/schema.js";
import { secrets } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import { SECRET_KINDS, URGENCIES, type Entity, type Secret } from "../world/types.js";
import type { WorldSettings } from "./context.js";

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };

export const PACES = ["quiet", "intimate", "social", "travel", "exploring", "investigating", "fighting"] as const;
export type Pace = (typeof PACES)[number];
const CALM = new Set<Pace>(["quiet", "intimate"]);
const HINT_CHANCE: Record<Pace, number> = { quiet: 0, intimate: 0, social: 0.25, travel: 0.25, fighting: 0.2, exploring: 0.45, investigating: 0.9 };
const COOLDOWN = 4;
const MAX_OPEN = 8;

/** What puts a secret in scope right now: the location chain, whoever and whatever is here, and what the player carries. */
export function scope(store: WorldStore, playerId: string): { ids: Set<string>; chain: Entity[]; present: Entity[] } {
  const ids = new Set<string>();
  const chain: Entity[] = [];
  const me = store.getEntity(playerId);
  for (let cur = me?.parent_id ? store.getEntity(me.parent_id) : null; cur; cur = cur.parent_id ? store.getEntity(cur.parent_id) : null) {
    chain.push(cur);
    ids.add(cur.id);
  }
  const present = me?.parent_id ? store.children(me.parent_id).filter((e) => e.id !== playerId) : [];
  for (const e of [...present, ...store.children(playerId)]) ids.add(e.id);
  return { ids, chain, present };
}

/** Rooms (a bathroom, a corridor) only carry secrets when marked notable; buildings and regions do unless marked otherwise. */
export const notable = (e: Entity): boolean => (e.kind === "room" ? e.props.notable === true : e.props.notable !== false);

const lastHint = (all: Secret[]) => Math.max(-99, ...all.map((s) => s.hinted_turn ?? -99));

/** At most one secret per turn, only if it's in scope and the moment allows it. */
export function selectHint(store: WorldStore, playerId: string, pace: Pace, turn: number, rng: () => number): { secret: Secret; ops: OpInput[] } | null {
  const all = secrets(store);
  const { ids } = scope(store, playerId);
  const searching = pace === "exploring" || pace === "investigating";
  const open = all.filter((s) => !s.revealed && (s.subjects.length ? s.subjects.some((id) => ids.has(id)) : searching));
  const since = turn - lastHint(all);
  let pool = open;
  if (CALM.has(pace)) {
    pool = open.filter((s) => s.urgency === "active");
    if (!pool.length || since < COOLDOWN * 2) return null;
  } else if (!pool.length || (pace !== "investigating" && since < COOLDOWN) || rng() >= HINT_CHANCE[pace]) {
    return null;
  }
  pool.sort((a, b) => (a.hinted_turn ?? -1) - (b.hinted_turn ?? -1));
  const secret = pool[Math.floor(rng() * Math.min(pool.length, 3))];
  if (!secret) return null;
  const ops: OpInput[] = [{ op: "hint", id: secret.id }];
  const threat = secret.kind === "danger" || secret.kind === "horror";
  if (threat && secret.urgency !== "active" && searching && rng() < 0.2) {
    ops.push({ op: "secret_urgency", id: secret.id, to: secret.urgency === "dormant" ? "stirring" : "active" });
  }
  return { secret, ops };
}

export function hintText(store: WorldStore, s: Secret): string {
  const names = (ids: string[]) => ids.map((id) => store.getEntity(id)?.name ?? id).join(", ");
  return [
    `A hidden truth that may color this scene [${s.id}] (${s.kind}${s.urgency === "active" ? ", actively closing in" : ""}): ${s.text}`,
    s.known_by.length ? `Known to: ${names(s.known_by)} (they act on it but never simply volunteer it).` : "",
    `Use at most one subtle, observable clue, or none if it would feel forced. Never state it outright. If the protagonist genuinely uncovers it this turn, emit {"op":"reveal","id":"${s.id}"}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Whether a new secret should appear this turn, and what it's about. New ground is likelier; isolation is rare. */
export function spawnSubject(store: WorldStore, playerId: string, pace: Pace, turn: number, rng: () => number): Entity | null {
  const all = secrets(store);
  const open = all.filter((s) => !s.revealed);
  if (open.length >= MAX_OPEN) return null;
  const covered = new Set(open.flatMap((s) => s.subjects));
  const { chain, present } = scope(store, playerId);
  const candidates = [...chain.slice(0, 2).filter(notable), ...present.filter((e) => e.kind === "character")].filter((e) => !covered.has(e.id));
  if (!candidates.length) return null;
  const fresh = candidates.filter((e) => e.created_turn >= turn - 2);
  const calm = CALM.has(pace);
  const pick = (xs: Entity[]) => xs[Math.floor(rng() * xs.length)] ?? null;
  if (fresh.length && rng() < (calm ? 0.05 : 0.35)) return pick(fresh);
  const base = calm ? 0.005 : pace === "exploring" || pace === "investigating" ? 0.05 : 0.015;
  return rng() < base ? pick(candidates) : null;
}

const Gen = z.object({
  text: z.string().min(1).max(2000).nullable(),
  kind: z.enum(SECRET_KINDS).catch("twist"),
  urgency: z.enum(URGENCIES).catch("dormant"),
  known_by: z.array(z.string()).catch([]),
});

const GEN_SYSTEM = `You invent ONE hidden truth for a text adventure that the protagonist does not know: something that could prove very useful, or dangerous, or terrifying. It must be about the given subject and consistent with the scene and world. Most places and people have nothing worth hiding: if this one is ordinary, output {"text": null}. Weight the kind by the world's tone: dark or horror worlds lean to dangers and horrors, light ones to boons and twists. Output ONLY JSON:
{"text": "the truth, stated plainly in 1-3 sentences", "kind": "boon"|"danger"|"horror"|"twist", "urgency": "dormant"|"stirring"|"active", "known_by": [ids of characters who know it, may be empty]}
Most secrets are "dormant"; "active" only for a threat already moving against the protagonist.`;

export async function generateSecret(llm: Llm, s: WorldSettings, scene: string, subject: Entity, present: Entity[]): Promise<{ op: OpInput | null; cost: number }> {
  const res = await llm.chat({
    model: s.parserModel,
    json: true,
    maxTokens: 300,
    temperature: 0.9,
    messages: [
      { role: "system", content: GEN_SYSTEM },
      { role: "user", content: `World: ${s.title}\n${s.premise}\nTone: ${s.style}\n\nScene:\n${scene}\n\nSubject: ${subject.name} [${subject.id}]` },
    ],
  });
  try {
    const g = Gen.parse(JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim()));
    if (!g.text) return { op: null, cost: res.costUsd };
    const ok = new Set(present.filter((e) => e.kind === "character").map((e) => e.id));
    return { op: { op: "secret", text: g.text, kind: g.kind, urgency: g.urgency, subjects: [subject.id], known_by: g.known_by.filter((id) => ok.has(id)) }, cost: res.costUsd };
  } catch {
    return { op: null, cost: res.costUsd };
  }
}
