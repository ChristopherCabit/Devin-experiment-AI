import type { TurnLog } from "../engine/turns.js";
import { charProps, clockMinutes, itemProps, roomProps } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import type { Entity } from "../world/types.js";

export const DEATH_POLICIES = ["ironman", "checkpoint", "consequence", "narrative"] as const;
export type DeathPolicy = (typeof DEATH_POLICIES)[number];

export interface WorldSettings {
  title: string;
  premise: string;
  style: string;
  intensity: "none" | "mild" | "explicit";
  limits: string;
  deathPolicy: DeathPolicy;
  narratorModel: string;
  parserModel: string;
  contextTokens: number;
}

export const DEFAULT_SETTINGS: WorldSettings = {
  title: "Untitled",
  premise: "",
  style: "Grounded, vivid, second person, present tense. Around 150-250 words per turn.",
  intensity: "explicit",
  limits: "",
  deathPolicy: "consequence",
  narratorModel: "deepseek/deepseek-chat-v3-0324",
  parserModel: "deepseek/deepseek-chat-v3-0324",
  contextTokens: 24000,
};

export function getSettings(store: WorldStore): WorldSettings {
  return { ...DEFAULT_SETTINGS, ...store.getMeta<Partial<WorldSettings>>("settings", {}) };
}

export const approxTokens = (s: string): number => Math.ceil(s.length / 4);

function clock(store: WorldStore): string {
  const m = clockMinutes(store);
  const day = Math.floor(m / 1440) + 1;
  const hh = String(Math.floor((m % 1440) / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `Day ${day}, ${hh}:${mm}`;
}

const SPEC_SKIP = new Set(["is_player", "scene", "mind", "sheet", "age"]);

function itemLine(store: WorldStore, e: Entity, depth = 0): string[] {
  const p = itemProps(e);
  const tags = [p.zone ? `at ${p.zone}` : null, p.closed ? "closed" : null, ...(p.conditions ?? [])].filter(Boolean);
  const lines = [`${"  ".repeat(depth)}- ${e.name} [${e.id}]${tags.length ? ` (${tags.join(", ")})` : ""}`];
  if (!p.closed) for (const c of store.children(e.id)) lines.push(...itemLine(store, c, depth + 1));
  return lines;
}

function sheetLines(e: Entity): string[] {
  const s = charProps(e).sheet;
  const fmt = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} ${v}/10`).join(", ") || "none";
  const res = Object.entries(s.resources).map(([k, r]) => `${k} ${r.value}${r.max !== undefined ? `/${r.max}` : ""}`).join(", ");
  return [
    `  power tier ${s.power_tier}/10; attributes: ${fmt(s.attributes)}; skills: ${fmt(s.skills)}; abilities: ${fmt(s.abilities)}`,
    ...(res ? [`  resources: ${res}`] : []),
  ];
}

function characterBlock(store: WorldStore, e: Entity, isPlayer: boolean): string[] {
  const p = charProps(e);
  const conds = (e.props.conditions as string[] | undefined) ?? [];
  const held = [p.scene.hands.left, p.scene.hands.right].filter((x): x is string => !!x).map((id) => store.getEntity(id)?.name ?? id);
  const worn = Object.entries(p.scene.worn).map(([slot, id]) => `${slot}: ${store.getEntity(id)?.name ?? id}`);
  const rel = p.scene.relations.map((r) => `${r.type} ${store.getEntity(r.target)?.name ?? r.target}`);
  const lines = [
    `### ${isPlayer ? "YOU (the protagonist)" : e.name} [${e.id}]${p.age ? `, age ${p.age}` : ", age UNRECORDED"}`,
    `  position: ${p.scene.zone ?? "somewhere in the room"}, ${p.scene.posture}${p.scene.hidden ? ", hidden" : ""}`,
    `  holding: ${held.join(", ") || "nothing"}; wearing: ${worn.join(", ") || "nothing recorded"}`,
  ];
  if (rel.length) lines.push(`  relations: ${rel.join("; ")}`);
  if (conds.length) lines.push(`  conditions: ${conds.join(", ")}`);
  lines.push(...sheetLines(e));
  for (const [k, v] of Object.entries(e.props)) {
    if (SPEC_SKIP.has(k) || k === "conditions" || v === null || v === undefined || v === "") continue;
    lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  if (!isPlayer) {
    if (p.mind.emotions.length) lines.push(`  current emotions (may conflict): ${p.mind.emotions.join(", ")}`);
    const thoughts = Object.entries(p.mind.thoughts);
    for (let i = thoughts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [thoughts[i], thoughts[j]] = [thoughts[j] as [string, string], thoughts[i] as [string, string]];
    }
    if (thoughts.length) lines.push("  private thoughts:", ...thoughts.map(([k, t]) => `    (${k}) ${t}`));
    const notes = Object.entries(p.mind.relationship_notes);
    if (notes.length) lines.push(...notes.map(([id, t]) => `  about ${store.getEntity(id)?.name ?? id}: ${t}`));
  }
  const carried = store.children(e.id).filter((c) => !held.includes(c.name));
  if (isPlayer && carried.length) lines.push("  carrying:", ...carried.flatMap((c) => itemLine(store, c, 2)));
  return lines;
}

export function describeScene(store: WorldStore, playerId: string): { text: string; present: Entity[] } {
  const player = store.getEntity(playerId);
  if (!player) throw new Error("no player");
  const here = player.parent_id ? store.getEntity(player.parent_id) : null;
  const lines = [`Time: ${clock(store)}`];
  const present: Entity[] = [];
  if (here) {
    const path: string[] = [];
    for (let cur: Entity | null = here; cur; cur = cur.parent_id ? store.getEntity(cur.parent_id) : null) path.unshift(cur.name);
    lines.push(`Location: ${path.join(" > ")} [${here.id}]`);
    const rp = roomProps(here);
    if (here.props.description) lines.push(`Description: ${String(here.props.description)}`);
    if (rp.zones.length) lines.push(`Zones: ${rp.zones.join(", ")}`);
    const siblings = store.children(here.parent_id ?? "").filter((r) => r.kind === "room" && r.id !== here.id);
    if (siblings.length) lines.push(`Other rooms here: ${siblings.map((r) => `${r.name} [${r.id}]`).join(", ")}`);
    const things = store.children(here.id).filter((c) => c.kind === "item" || c.kind === "container");
    if (things.length) lines.push("Objects:", ...things.flatMap((t) => itemLine(store, t)));
    for (const c of store.children(here.id)) {
      if (c.kind === "character" && c.id !== playerId) present.push(c);
    }
  }
  lines.push("", ...characterBlock(store, player, true));
  for (const c of present) lines.push("", ...characterBlock(store, c, false));
  const facts = store.facts().slice(-30);
  if (facts.length) lines.push("", "Established facts:", ...facts.map((f) => `- ${f.text}`));
  return { text: lines.join("\n"), present };
}

/** Most recent turns that fit the character budget, oldest first. */
export function recentStory(log: TurnLog, budgetTokens: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const t of log.history(200).reverse()) {
    if (t.kind === "author" || t.kind === "system") continue;
    const block = [t.input && t.kind !== "continue" ? `> ${t.input}` : "", t.output].filter(Boolean).join("\n");
    used += approxTokens(block);
    if (used > budgetTokens) break;
    parts.unshift(block);
  }
  return parts.join("\n\n");
}
