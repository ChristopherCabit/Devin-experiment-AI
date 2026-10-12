import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { OpInput } from "../ops/schema.js";
import { charProps, itemProps } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import { Sheet, type Entity } from "../world/types.js";
import type { WorldSettings } from "./context.js";
import { resolveCheck, type Difficulty, type Outcome } from "./dice.js";

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };
type StatPath = "attributes" | "skills" | "abilities";

export const ATTRIBUTES = ["strength", "agility", "wits", "charm"] as const;
export const STATS_MODES = ["pointbuy", "proposed", "freeform"] as const;
export type StatsMode = (typeof STATS_MODES)[number];

/** Highest tier the player may reach; only the manual "unbounded power" switch lifts it. */
export const playerCap = (s: Pick<WorldSettings, "powerCeiling" | "unboundedPower">): number => (s.unboundedPower ? 10 : s.powerCeiling);

export const pointBudget = (ceiling: number): number => 8 + 3 * ceiling;

export function pointCost(s: Pick<Sheet, StatPath>): number {
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return sum(s.attributes) + sum(s.skills) + 2 * sum(s.abilities);
}

/** General capability when no listed stat applies: the average attribute. */
export function derivePower(s: Pick<Sheet, "attributes">): number {
  const v = Object.values(s.attributes);
  return v.length ? Math.max(1, Math.round(v.reduce((a, b) => a + b, 0) / v.length)) : 3;
}

export const isRated = (s: Sheet): boolean =>
  s.power_tier !== 1 || Object.keys(s.attributes).length + Object.keys(s.skills).length + Object.keys(s.abilities).length > 0;

function statOf(s: Sheet, key: string): { path: StatPath; value: number } | null {
  for (const path of ["skills", "attributes", "abilities"] as const) {
    const v = s[path][key];
    if (v !== undefined) return { path, value: v };
  }
  return null;
}

/** Bonus from items held or worn (at most ±3 in total). */
export function gearBonus(store: WorldStore, e: Entity, key: string | null): number {
  const sc = charProps(e).scene;
  let total = 0;
  for (const id of [sc.hands.left, sc.hands.right, ...Object.values(sc.worn)]) {
    const it = id ? store.getEntity(id) : null;
    const g = it ? itemProps(it).grants : undefined;
    if (g) total += (key ? g[key] : undefined) ?? g.power ?? 0;
  }
  return Math.max(-3, Math.min(3, total));
}

/** Tier used for a check: the stat (or power tier), plus gear, plus a numbers bonus for groups. */
export function effectiveTier(store: WorldStore, e: Entity | null, skill: string | null): number | null {
  if (!e || e.kind !== "character") return null;
  const p = charProps(e);
  const base = (skill ? statOf(p.sheet, skill)?.value : undefined) ?? p.sheet.power_tier;
  const crowd = p.group && p.group.count > 1 ? Math.min(3, Math.floor(Math.log2(p.group.count))) : 0;
  return Math.max(0, Math.min(13, base + gearBonus(store, e, skill) + crowd));
}

const GAIN: Record<Outcome, number> = { success: 2, success_at_cost: 1, failure: 1, failure_with_complication: 0 };

/** Adds progress to a stat; crossing 4 + 2×tier raises it one tier, never past `limit`. */
function advance(store: WorldStore, playerId: string, key: string, gain: number, limit: number): { ops: OpInput[]; note: string | null } {
  const me = store.getEntity(playerId);
  if (!me || gain <= 0) return { ops: [], note: null };
  const sheet = charProps(me).sheet;
  const stat = statOf(sheet, key) ?? { path: "skills" as const, value: 0 };
  if (stat.value >= limit) return { ops: [], note: null };
  const threshold = 4 + 2 * stat.value;
  const progress = (sheet.progress[key] ?? 0) + gain;
  if (progress < threshold) return { ops: [{ op: "practice", character: playerId, key, value: progress }], note: null };
  return {
    ops: [
      { op: "progression", character: playerId, path: stat.path, key, to: stat.value + 1 },
      { op: "practice", character: playerId, key, value: progress - threshold },
    ],
    note: `${key} improved to ${stat.value + 1}`,
  };
}

/** Practice from a resolved check; crossing the threshold raises the stat one tier (never past the cap). */
export function practiceOps(
  store: WorldStore,
  playerId: string,
  skill: string | null,
  difficulty: Difficulty,
  outcome: Outcome,
  mine: number,
  opp: number,
  s: WorldSettings,
): { ops: OpInput[]; note: string | null } {
  if (!skill || !s.progression.practice || difficulty === "trivial" || difficulty === "impossible") return { ops: [], note: null };
  return advance(store, playerId, skill, GAIN[outcome] * (opp >= mine ? 2 : 1), playerCap(s));
}

/** Training under a present NPC who is better at the skill; capped at the mentor's level. */
export function trainOps(store: WorldStore, playerId: string, teacherId: string, skill: string, s: WorldSettings): { ops: OpInput[]; note: string } | null {
  const me = store.getEntity(playerId);
  const t = store.getEntity(teacherId);
  if (!s.progression.mentors || !me || !t || t.kind !== "character" || t.parent_id !== me.parent_id) return null;
  const theirs = statOf(charProps(t).sheet, skill)?.value ?? 0;
  const mine = statOf(charProps(me).sheet, skill)?.value ?? 0;
  if (theirs <= mine) return { ops: [{ op: "time_advance", minutes: 60 }], note: `${t.name} has nothing more to teach about ${skill}` };
  const r = advance(store, playerId, skill, 3, Math.min(theirs, playerCap(s)));
  return { ops: [...r.ops, { op: "time_advance", minutes: 120 }], note: r.note ?? `trained ${skill} with ${t.name}` };
}

/** Cultivating: builds progress (faster with the world's resource); at the threshold, a breakthrough check. */
export function cultivateOps(store: WorldStore, playerId: string, s: WorldSettings, rng: () => number): { ops: OpInput[]; note: string } | null {
  const c = s.progression.cultivation;
  const me = store.getEntity(playerId);
  if (!c || !me) return null;
  const sheet = charProps(me).sheet;
  const realm = Math.min(sheet.abilities.cultivation ?? 0, c.realms.length - 1);
  const ops: OpInput[] = [{ op: "time_advance", minutes: 120 }];
  if (realm >= c.realms.length - 1) return { ops, note: `already at the peak realm, ${c.realms[realm]}` };
  let gain = 2;
  const resKey = c.resource ? Object.keys(sheet.resources).find((k) => k.toLowerCase() === c.resource?.toLowerCase()) : undefined;
  if (resKey && (sheet.resources[resKey]?.value ?? 0) > 0) {
    gain += 3;
    ops.push({ op: "resource_delta", character: playerId, resource: resKey, delta: -1 });
  }
  const threshold = 6 + 4 * realm;
  const progress = (sheet.progress.cultivation ?? 0) + gain;
  if (progress < threshold) {
    ops.push({ op: "practice", character: playerId, key: "cultivation", value: progress });
    return { ops, note: `cultivation progress ${progress}/${threshold}${resKey && gain > 2 ? ` (used 1 ${resKey})` : ""}` };
  }
  const r = resolveCheck(realm < 2 ? "moderate" : realm < 5 ? "hard" : "extreme", 0, 0, rng);
  const next = c.realms[realm + 1] ?? "the next realm";
  if (r.outcome === "success" || r.outcome === "success_at_cost") {
    ops.push(
      { op: "progression", character: playerId, path: "abilities", key: "cultivation", to: realm + 1 },
      { op: "practice", character: playerId, key: "cultivation", value: 0 },
    );
    if (sheet.power_tier < playerCap(s)) ops.push({ op: "progression", character: playerId, path: "power_tier", to: sheet.power_tier + 1 });
    if (r.outcome === "success_at_cost") ops.push({ op: "set_condition", id: playerId, add: ["drained"] });
    return { ops, note: `breakthrough to ${next}${r.outcome === "success_at_cost" ? ", leaving you drained" : ""} (rolled ${r.roll})` };
  }
  if (r.outcome === "failure") {
    ops.push({ op: "practice", character: playerId, key: "cultivation", value: Math.floor(threshold / 2) });
    return { ops, note: `breakthrough to ${next} failed; progress lost (rolled ${r.roll})` };
  }
  ops.push(
    { op: "practice", character: playerId, key: "cultivation", value: 0 },
    { op: "set_condition", id: playerId, add: ["qi deviation"] },
    { op: "resource_delta", character: playerId, resource: "hp", delta: -2 },
  );
  return { ops, note: `breakthrough to ${next} failed badly: qi deviation (rolled ${r.roll})` };
}

/** Using up a carried tome/potion: raises taught stats (to the cap) and removes the item. */
export function consumeOps(store: WorldStore, playerId: string, itemId: string, s: WorldSettings): { ops: OpInput[]; note: string } | null {
  const it = store.getEntity(itemId);
  const me = store.getEntity(playerId);
  if (!it || !me || it.parent_id !== playerId) return null;
  const ip = itemProps(it);
  if (!ip.teaches && !ip.consumable) return null;
  const sheet = charProps(me).sheet;
  const ops: OpInput[] = [];
  const gained: string[] = [];
  for (const [key, to] of Object.entries(ip.teaches ?? {})) {
    const stat = statOf(sheet, key) ?? { path: ATTRIBUTES.includes(key as (typeof ATTRIBUTES)[number]) ? ("attributes" as const) : ("skills" as const), value: 0 };
    const target = Math.min(to, playerCap(s));
    if (target > stat.value) {
      ops.push({ op: "progression", character: playerId, path: stat.path, key, to: target });
      gained.push(`${key} ${target}`);
    }
  }
  if (ip.consumable || ip.teaches) {
    for (const hand of ["left", "right"] as const) {
      if (charProps(me).scene.hands[hand] === itemId) ops.unshift({ op: "release", character: playerId, item: itemId });
    }
    ops.push({ op: "remove_entity", id: itemId });
  }
  return { ops, note: gained.length ? `${it.name} used up; ${gained.join(", ")}` : `${it.name} used up` };
}

const Cast = z.object({
  age: z.number().int().positive().nullable().catch(null),
  power_tier: z.number().int().min(0).max(10).catch(3),
  attributes: z.record(z.string(), z.number().int().min(0).max(10)).catch({}),
  skills: z.record(z.string(), z.number().int().min(0).max(10)).catch({}),
  abilities: z.record(z.string(), z.number().int().min(0).max(10)).catch({}),
  hp: z.number().int().min(1).max(1000).catch(10),
  count: z.number().int().min(1).max(100000).nullable().catch(null),
});
export type Cast = z.infer<typeof Cast>;

const SCALE = "Scale 0-10: 1 feeble, 3 ordinary adult, 5 trained professional (soldier, veteran thief), 7 elite or champion, 9 legendary, 10 godlike.";

const CAST_SYSTEM = `You assign game stats to one character (or group) in a text adventure. Output ONLY JSON:
{"age": int|null, "power_tier": int, "attributes": {"strength": int, "agility": int, "wits": int, "charm": int}, "skills": {name: int}, "abilities": {name: int}, "hp": int, "count": int|null}
${SCALE} Give 1-4 skills that fit the role; abilities only for supernatural powers the world has. hp: ordinary person 8-10, tough fighter 12-16, large creatures more. "count": how many individuals if this is a group (gang, squad, pack, army), else null; a group's stats are those of a typical member. Judge from the role, description and world, never from what would make the story convenient for anyone.`;

export function castToSheet(c: Cast): Sheet {
  return Sheet.parse({ power_tier: c.power_tier, attributes: c.attributes, skills: c.skills, abilities: c.abilities, resources: { hp: { value: c.hp, max: c.hp } } });
}

export async function castCharacter(llm: Llm, s: WorldSettings, who: string, scene: string): Promise<{ cast: Cast; cost: number }> {
  const res = await llm.chat({
    model: s.parserModel,
    json: true,
    maxTokens: 300,
    temperature: 0.4,
    messages: [
      { role: "system", content: CAST_SYSTEM },
      { role: "user", content: `World: ${s.title}\n${s.premise}\nTypical power in this world reaches about ${s.powerCeiling}/10.\n\nScene:\n${scene}\n\nCharacter: ${who}` },
    ],
  });
  let cast: Cast;
  try {
    cast = Cast.parse(JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim()));
  } catch {
    cast = Cast.parse({});
  }
  return { cast, cost: res.costUsd };
}

export { SCALE as STAT_SCALE };
