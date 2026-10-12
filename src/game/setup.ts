import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { OpInput } from "../ops/schema.js";
import { slugify } from "../world/queries.js";
import { Sheet, Tier } from "../world/types.js";
import { DEATH_POLICIES, Progression, type WorldSettings } from "./context.js";
import { SECRET_KINDS, URGENCIES } from "../world/types.js";
import { derivePower, playerCap, pointBudget, pointCost, STAT_SCALE, STATS_MODES } from "./rules.js";
import { PLAYER_ID, type Seed } from "./seeds.js";

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };
const Str = (max: number) => z.string().trim().max(max);
const Name = z.string().trim().min(1).max(80);
const Stats = z.record(z.string().trim().toLowerCase().min(1).max(40), Tier);

export const PlayerSpec = z.object({
  name: Name,
  age: z.number().int().min(18).max(100000),
  description: Str(2000).default(""),
  attributes: Stats.default({}),
  skills: Stats.default({}),
  abilities: Stats.default({}),
  hp: z.number().int().min(1).max(1000).default(10),
  coin: z.number().int().min(0).max(1000000).default(0),
  items: z.array(Name).max(20).default([]),
});
export type PlayerSpec = z.infer<typeof PlayerSpec>;

const DraftNpc = z.object({
  name: Name,
  age: z.number().int().positive().nullable().catch(null),
  description: Str(1000).catch(""),
  traits: Str(1000).catch(""),
  goals: Str(1000).catch(""),
  room: Str(80).optional().catch(undefined),
  sheet: Sheet.catch(Sheet.parse({})),
  count: z.number().int().min(2).max(100000).nullable().catch(null),
});

export const WorldDraft = z.object({
  opening: z.string().trim().min(1).max(4000),
  region: Name.catch("The World"),
  start: z.object({ place: Name, room: Name, zones: z.array(Name).max(12).catch([]), description: Str(1000).catch("") }),
  places: z
    .array(z.object({ name: Name, rooms: z.array(z.object({ name: Name, description: Str(1000).catch(""), notable: z.boolean().catch(false) })).max(8).catch([]) }))
    .max(12)
    .catch([]),
  npcs: z.array(DraftNpc).max(12).catch([]),
  secrets: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(2000),
        kind: z.enum(SECRET_KINDS).catch("twist"),
        urgency: z.enum(URGENCIES).catch("dormant"),
        about: z.array(Str(80)).catch([]),
        known_by: z.array(Str(80)).catch([]),
      }),
    )
    .max(8)
    .catch([]),
  cultivation: Progression.shape.cultivation.catch(null),
});
export type WorldDraft = z.infer<typeof WorldDraft>;

export const WorldBrief = z.object({
  title: Name,
  premise: Str(8000).default(""),
  situation: Str(4000).default(""),
  style: Str(2000).optional(),
  intensity: z.enum(["none", "mild", "explicit"]).default("explicit"),
  limits: Str(2000).default(""),
  deathPolicy: z.enum(DEATH_POLICIES).default("consequence"),
  powerCeiling: z.number().int().min(1).max(10).default(6),
  unboundedPower: z.boolean().default(false),
  progression: Progression.default({}),
});
export type WorldBrief = z.infer<typeof WorldBrief>;

export const AdventureSpec = z.object({
  name: Name,
  brief: WorldBrief,
  world: WorldDraft,
  statsMode: z.enum(STATS_MODES),
  player: PlayerSpec,
});

export class SetupError extends Error {}

/** Applies the world's cap (and the point budget unless freeform/unbounded) to a created character. */
export function playerSheet(p: PlayerSpec, b: WorldBrief, mode: (typeof STATS_MODES)[number]): Sheet {
  const cap = playerCap(b);
  const all = { ...p.attributes, ...p.skills, ...p.abilities };
  const over = Object.entries(all).find(([, v]) => v > cap);
  if (over) throw new SetupError(`${over[0]} ${over[1]} is above this world's cap of ${cap} (turn on unbounded power to allow it)`);
  const cost = pointCost(p);
  if (mode !== "freeform" && !b.unboundedPower && cost > pointBudget(b.powerCeiling)) {
    throw new SetupError(`stats cost ${cost} points; the budget is ${pointBudget(b.powerCeiling)}`);
  }
  return Sheet.parse({
    attributes: p.attributes,
    skills: p.skills,
    abilities: p.abilities,
    power_tier: Math.min(cap, derivePower(p)),
    resources: { hp: { value: p.hp, max: p.hp }, coin: { value: p.coin, min: 0, max: 1000000 } },
  });
}

export function buildSeed(spec: z.infer<typeof AdventureSpec>): Seed {
  const { brief: b, world: w, player: p } = spec;
  const sheet = playerSheet(p, b, spec.statsMode);
  const ids = new Set<string>();
  const id = (kind: string, name: string) => {
    let base = `${kind}:${slugify(name) || kind}`;
    for (let i = 2; ids.has(base); i++) base = `${kind}:${slugify(name) || kind}-${i}`;
    ids.add(base);
    return base;
  };
  const region = id("region", w.region);
  const startPlace = id("place", w.start.place);
  const startRoom = id("room", w.start.room);
  const ops: OpInput[] = [
    { op: "create_entity", id: region, kind: "region", name: w.region },
    { op: "create_entity", id: startPlace, kind: "place", name: w.start.place, parent: region },
    { op: "create_entity", id: startRoom, kind: "room", name: w.start.room, parent: startPlace, props: { zones: w.start.zones, description: w.start.description } },
  ];
  const rooms = new Map<string, string>([[w.start.room.toLowerCase(), startRoom]]);
  const named = new Map<string, string>([
    [w.region.toLowerCase(), region],
    [w.start.place.toLowerCase(), startPlace],
    [w.start.room.toLowerCase(), startRoom],
  ]);
  for (const pl of w.places) {
    const pid = id("place", pl.name);
    ops.push({ op: "create_entity", id: pid, kind: "place", name: pl.name, parent: region });
    named.set(pl.name.toLowerCase(), pid);
    for (const r of pl.rooms.length ? pl.rooms : [{ name: pl.name, description: "" }]) {
      const rid = id("room", r.name);
      rooms.set(r.name.toLowerCase(), rid);
      named.set(r.name.toLowerCase(), rid);
      ops.push({ op: "create_entity", id: rid, kind: "room", name: r.name, parent: pid, props: { description: r.description, notable: "notable" in r ? r.notable : false } });
    }
  }
  ops.push({
    op: "create_entity",
    id: PLAYER_ID,
    kind: "character",
    name: "You",
    aliases: [p.name],
    parent: startRoom,
    props: { is_player: true, age: p.age, true_name: p.name, description: p.description, sheet },
  });
  for (const it of p.items) ops.push({ op: "create_entity", id: id("item", it), kind: "item", name: it, parent: PLAYER_ID });
  for (const n of w.npcs) {
    const nid = id("character", n.name);
    named.set(n.name.toLowerCase(), nid);
    ops.push({
      op: "create_entity",
      id: nid,
      kind: "character",
      name: n.name,
      parent: rooms.get((n.room ?? "").toLowerCase()) ?? startRoom,
      props: { age: n.age, description: n.description, traits: n.traits, goals: n.goals, sheet: n.sheet, group: n.count ? { count: n.count } : null },
    });
  }
  const ref = (xs: string[]) => [...new Set(xs.map((x) => named.get(x.toLowerCase())).filter((x): x is string => !!x))];
  for (const sec of w.secrets) {
    ops.push({ op: "secret", text: sec.text, kind: sec.kind, urgency: sec.urgency, subjects: ref(sec.about), known_by: ref(sec.known_by).filter((x) => x.startsWith("character:")) });
  }
  const settings: Partial<WorldSettings> = {
    progression: b.progression,
    title: b.title,
    premise: [b.premise, `The protagonist: ${p.name}. ${p.description}`].filter(Boolean).join("\n\n"),
    intensity: b.intensity,
    limits: b.limits,
    deathPolicy: b.deathPolicy,
    powerCeiling: b.powerCeiling,
    unboundedPower: b.unboundedPower,
    ...(b.style ? { style: b.style } : {}),
  };
  return { settings, ops, opening: w.opening };
}

/** A world with only the starting location and the player's own opening text. */
export function blankDraft(b: WorldBrief, place: string, room: string): WorldDraft {
  return WorldDraft.parse({ opening: b.situation || `You are in ${room}.`, start: { place, room }, places: [], npcs: [] });
}

const json = (t: string): unknown => JSON.parse(t.replace(/^```(?:json)?|```$/g, "").trim());

const WORLD_SYSTEM = `You design the starting state of a second-person text adventure from the player's brief. Output ONLY JSON:
{"opening": "2-4 paragraphs, second person, present tense, ending where the player can act", "region": str, "start": {"place": str, "room": str, "zones": [str], "description": str}, "places": [{"name": str, "rooms": [{"name": str, "description": str}]}], "npcs": [{"name": str, "age": int|null, "description": str, "traits": str, "goals": str, "room": str, "sheet": {"power_tier": int, "attributes": {"strength","agility","wits","charm"}, "skills": {..}, "resources": {"hp": {"value": n, "max": n}}}, "count": int|null}],
 "secrets": [{"text": str, "kind": "boon"|"danger"|"horror"|"twist", "urgency": "dormant"|"stirring"|"active", "about": [names of places/rooms/NPCs it belongs to], "known_by": [NPC names]}],
 "cultivation": {"realms": [str, ...], "resource": str|null} | null}
Rooms in "places" may have "notable": true when something important is there (a crypt, a vault); ordinary rooms are not notable.
"secrets": 2-5 hidden truths the protagonist does not know, very useful or dangerous or terrifying, weighted by the tone; each tied to a specific place, person or group. Not every place or person has one.
"cultivation": a realm ladder only if the premise has cultivation or a similar power ladder, else null.
${STAT_SCALE} Characters in this world reach about CEILING/10. "count" is for groups (a squad, gang, army) whose sheet is a typical member. NPC "room" must be the start room or a room in "places". Do not describe the protagonist's feelings or choices. NPCLINE`;

export async function generateDraft(llm: Llm, model: string, b: WorldBrief, withNpcs: boolean): Promise<{ draft: WorldDraft; cost: number }> {
  const system = WORLD_SYSTEM.replace("CEILING", String(b.powerCeiling)).replace(
    "NPCLINE",
    withNpcs ? "Include 1-5 NPCs who matter to the premise." : 'The protagonist starts alone: "npcs" must be [].',
  );
  const res = await llm.chat({
    model,
    json: true,
    maxTokens: 2500,
    temperature: 0.8,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Title: ${b.title}\nPremise: ${b.premise}\nStarting situation: ${b.situation}\nContent intensity: ${b.intensity}` },
    ],
  });
  let draft: WorldDraft;
  try {
    draft = WorldDraft.parse(json(res.text));
  } catch {
    throw new SetupError("the model returned an unusable world; try again");
  }
  if (!withNpcs) draft.npcs = [];
  return { draft, cost: res.costUsd };
}

const PROPOSE_SYSTEM = `You turn a player's character description into game stats. Output ONLY JSON: {"attributes": {"strength": int, "agility": int, "wits": int, "charm": int}, "skills": {name: int}, "abilities": {name: int}, "hp": int}
${STAT_SCALE} Give 2-5 skills from the description; abilities only for supernatural powers it describes. Be honest about weaknesses; do not inflate.`;

/** Model-proposed stats, then scaled down to fit the cap and budget. */
export async function proposeStats(llm: Llm, model: string, description: string, b: WorldBrief): Promise<{ stats: Pick<PlayerSpec, "attributes" | "skills" | "abilities" | "hp">; cost: number }> {
  const res = await llm.chat({
    model,
    json: true,
    maxTokens: 300,
    temperature: 0.3,
    messages: [
      { role: "system", content: PROPOSE_SYSTEM },
      { role: "user", content: `World power reaches about ${b.powerCeiling}/10.\nCharacter: ${description}` },
    ],
  });
  const P = z.object({ attributes: Stats.catch({}), skills: Stats.catch({}), abilities: Stats.catch({}), hp: z.number().int().min(1).max(1000).catch(10) });
  let stats: z.infer<typeof P>;
  try {
    stats = P.parse(json(res.text));
  } catch {
    stats = P.parse({});
  }
  const cap = playerCap(b);
  for (const path of ["attributes", "skills", "abilities"] as const) {
    for (const k of Object.keys(stats[path])) stats[path][k] = Math.min(cap, stats[path][k] ?? 0);
  }
  if (!b.unboundedPower) {
    const budget = pointBudget(b.powerCeiling);
    while (pointCost(stats) > budget) {
      const all = (["abilities", "skills", "attributes"] as const).flatMap((path) => Object.entries(stats[path]).map(([k, v]) => ({ path, k, v })));
      const top = all.sort((x, y) => y.v - x.v)[0];
      if (!top || top.v <= 0) break;
      stats[top.path][top.k] = top.v - 1;
    }
  }
  return { stats, cost: res.costUsd };
}
