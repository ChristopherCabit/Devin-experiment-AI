import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import { FACT_KINDS, type OpInput } from "../ops/schema.js";
import { normalizeName } from "../parser/fastpath.js";
import { ancestors, charProps, clockMinutes, isLocation, roomProps, slugify } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import type { Entity } from "../world/types.js";
import { clockAt, type WorldSettings } from "./context.js";

/**
 * State sync: after a passage is written, a dedicated call reads it against the records and reports
 * where everyone ended up, what they hold, coin, time and established details. It reports resulting
 * state rather than changes, so code can diff it against the records and nothing is applied twice.
 */
export const SYNC_PROMPT = `You keep a story game's records in line with what the story passage says happened. The records are below with ids in [brackets]. Read the passage and report the state at the END of the passage, only where it differs from the records or the passage changed it. Output JSON:
{"minutes":int,
 "people":[{"id":ID,"room":ID|null,"left_for":str|null,"zone":str|null,"posture":str|null,"holding":[ID or "new: short item name"]|null}],
 "coins":[{"id":ID,"now":int|null,"change":int|null,"why":str}],
 "items":[{"id":ID or "new: short item name","where":ID,"zone":str|null}],
 "details":[{"text":str,"kind":"price"|"wage"|"deadline"|"agreement"|"ownership"|"said"|"fact","subjects":[ID],"replaces":int|null}],
 "earshot":[{"a":ID,"b":ID,"open":bool}]}
- minutes: in-story time the whole passage covers, counted from the end of the previous passage (a short exchange 1-3, a meal 30, a night's sleep 480). 0 if it only describes a moment.
- people: everyone in the records whose room, spot (zone), posture or what they hold in their hands is now different. room: a Place id when they end up in a known place. left_for: when they leave for somewhere not listed, a short name for it ("the forge", "upstairs"); room null then. holding: the full list of what is in their hands at the end (at most 2), [] for empty hands. Use null for anything unchanged. Never invent movement the passage doesn't show.
- coins: money that changed hands in the passage. now: the purse total when the passage makes it clear; otherwise change (+ received, - paid). Coins are counted in the smallest coin the records use. Only for people whose Coin is listed.
- items: a thing put down, moved, left behind or newly shown in a specific place that matters (not scenery). where: a Place or person id.
- details: concrete specifics a later scene must not contradict that are not already in Established details: prices, wages, debts, deadlines and times agreed, deals and promises, who owns what, and notable claims or statements a character made (kind "said": "Mara said the well froze last winter"). One short sentence each, with exact numbers and names, attributed. replaces: the #number of an Established detail this one updates or corrects (a new price, a moved deadline, a changed deal); never duplicate one that still holds. Not moods, feelings, or anything momentary. Usually 0-3.
- earshot: only when the passage shows whether ordinary speech carries between two listed rooms (a door left open, an arch, a thin wall: open true; a door shut: open false).
Empty arrays when nothing applies.`;

const Id = z.string().transform((x) => x.trim().replace(/^\[|\]$/g, ""));
const arr = <T extends z.ZodTypeAny>(t: T) => z.array(t.catch(null as never)).catch([]).transform((xs) => xs.filter((x) => x !== null && x !== undefined));
export const SyncResult = z.object({
  minutes: z.number().catch(0).default(0),
  people: arr(
    z.object({
      id: Id,
      room: Id.nullable().catch(null).default(null),
      left_for: z.string().nullable().catch(null).default(null),
      zone: z.string().nullable().catch(null).default(null),
      posture: z.string().nullable().catch(null).default(null),
      holding: z.array(z.string()).nullable().catch(null).default(null),
    }),
  ).default([]),
  coins: arr(z.object({ id: Id, now: z.number().nullable().catch(null).default(null), change: z.number().nullable().catch(null).default(null), why: z.string().catch("").default("") })).default([]),
  items: arr(z.object({ id: z.string(), where: Id, zone: z.string().nullable().catch(null).default(null) })).default([]),
  details: arr(
    z.object({
      text: z.string().trim().min(3).max(300),
      kind: z.enum(FACT_KINDS).catch("fact").default("fact"),
      subjects: z.array(Id).catch([]).default([]),
      replaces: z.number().int().nullable().catch(null).default(null),
    }),
  ).default([]),
  earshot: arr(z.object({ a: Id, b: Id, open: z.boolean() })).default([]),
});
export type SyncResult = z.output<typeof SyncResult>;

const coinOf = (c: Entity): number | null => {
  const r = charProps(c).sheet.resources.coin;
  return r ? r.value : null;
};

/** People, places, things and details the sync call works with. */
export function syncScope(store: WorldStore, playerId: string, named: Entity[] = []): { people: Entity[]; places: Entity[] } {
  const player = store.getEntity(playerId);
  const here = player?.parent_id ? store.getEntity(player.parent_id) : null;
  const chain = here ? [here, ...ancestors(store, here.id)] : [];
  const building = chain.find((e) => e.kind === "place") ?? null;
  const region = chain.find((e) => e.kind === "region") ?? null;
  const under = (root: Entity | null) => (root ? store.allEntities().filter((e) => isLocation(e) && ancestors(store, e.id).some((a) => a.id === root.id)) : []);
  const places = [...new Map([...(here ? [here] : []), ...under(building), ...(building ? [building] : []), ...under(region).filter((e) => e.kind === "place")].map((e) => [e.id, e])).values()].slice(0, 40);
  const placeIds = new Set(places.filter((p) => p.kind === "room" || p.id === here?.id).map((p) => p.id));
  const people = [
    ...new Map(
      [...(player ? [player] : []), ...store.entitiesOfKind("character").filter((c) => c.parent_id && placeIds.has(c.parent_id) && !(c.props as { group?: unknown }).group), ...named].map((c) => [c.id, c]),
    ).values(),
  ].slice(0, 20);
  return { people, places };
}

export function syncRecords(store: WorldStore, playerId: string, named: Entity[] = []): { text: string; people: Entity[]; places: Entity[] } {
  const { people, places } = syncScope(store, playerId, named);
  const nameOf = (id: string | null | undefined) => (id ? (store.getEntity(id)?.name ?? id) : "nowhere");
  const lines = [`Time: ${clockAt(clockMinutes(store))}`, "", "Places:"];
  for (const p of places) {
    const rp = roomProps(p);
    lines.push(`- ${p.name} [${p.id}] (${p.kind}, in ${nameOf(p.parent_id)})${rp.zones.length ? ` spots: ${rp.zones.join(", ")}` : ""}${rp.open_to.length ? `; within earshot of ${rp.open_to.map(nameOf).join(", ")}` : ""}`);
    const loose = store.children(p.id).filter((c) => c.kind === "item" || c.kind === "container");
    if (loose.length) lines.push(`  things here: ${loose.map((t) => `${t.name} [${t.id}]${(t.props as { zone?: string }).zone ? ` at ${(t.props as { zone?: string }).zone}` : ""}`).join("; ")}`);
  }
  lines.push("", "People:");
  for (const c of people) {
    const sc = charProps(c).scene;
    const hands = [sc.hands.left, sc.hands.right].filter((x): x is string => !!x);
    const carried = store.children(c.id).filter((x) => !hands.includes(x.id) && !Object.values(sc.worn).includes(x.id));
    const coin = coinOf(c);
    lines.push(
      `- ${c.id === playerId ? "YOU (protagonist) " : ""}${c.name} [${c.id}]: in ${nameOf(c.parent_id)} [${c.parent_id ?? "-"}]${sc.zone ? `, at ${sc.zone}` : ""}, ${sc.posture}; hands: ${hands.map((h) => `${nameOf(h)} [${h}]`).join(", ") || "empty"}` +
        (Object.keys(sc.worn).length ? `; wearing: ${Object.values(sc.worn).map((w) => `${nameOf(w)} [${w}]`).join(", ")}` : "") +
        (carried.length ? `; carrying: ${carried.map((x) => `${x.name} [${x.id}]`).join(", ")}` : "") +
        (coin !== null ? `; Coin: ${coin}` : ""),
    );
  }
  const ids = new Set([...people, ...places].map((e) => e.id));
  const facts = store.activeFacts().filter((f) => !f.subjects.length || f.subjects.some((x) => ids.has(x))).slice(-60);
  lines.push("", "Established details:", ...(facts.length ? facts.map((f) => `- (#${f.id}, ${f.kind}) ${f.text}`) : ["(none)"]));
  return { text: lines.join("\n"), people, places };
}

const key = (s: string) => normalizeName(s).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function uniqueId(store: WorldStore, kind: string, name: string, taken: Set<string>): string {
  const base = `${kind}:${slugify(name) || kind}`;
  let id = base;
  for (let i = 2; store.getEntity(id) || taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

/** Turns a sync report into validated ops; anything that doesn't fit the records is left out with a note. */
export function syncOps(store: WorldStore, playerId: string, r: SyncResult, advanced: number, people: Entity[], places: Entity[], notes: string[] = []): OpInput[] {
  const ops: OpInput[] = [];
  const known = new Map(people.map((c) => [c.id, c]));
  const taken = new Set<string>();
  const findItem = (name: string, near: string[]): string | null => {
    const k = key(name);
    for (const at of near) {
      const hit = [...store.children(at), ...store.children(at).flatMap((x) => store.children(x.id))].find((e) => (e.kind === "item" || e.kind === "container") && [e.name, ...e.aliases].some((n) => key(n) === k));
      if (hit) return hit.id;
    }
    return null;
  };
  const newItem = (raw: string, parent: string, near: string[]): string | null => {
    const m = /^new:\s*(.+)$/i.exec(raw.trim());
    if (!m) return store.getEntity(raw.replace(/^\[|\]$/g, "")) ? raw.replace(/^\[|\]$/g, "") : null;
    const name = (m[1] ?? "").trim().slice(0, 80);
    if (!name) return null;
    const same = findItem(name, near);
    if (same) return same;
    const id = uniqueId(store, "item", name, taken);
    ops.push({ op: "create_entity", id, kind: "item", name, parent });
    return id;
  };
  const locate = (name: string, from: Entity): string | null => {
    const n = key(name);
    if (!n) return null;
    const hit = places.find((p) => [p.name, ...p.aliases].some((x) => key(x) === n)) ?? store.allEntities().find((e) => isLocation(e) && [e.name, ...e.aliases].some((x) => key(x) === n));
    if (hit) return hit.kind === "place" ? (store.children(hit.id).find((c) => c.kind === "room")?.id ?? hit.id) : hit.id;
    const here = from.parent_id ? store.getEntity(from.parent_id) : null;
    const chain = here ? [here, ...ancestors(store, here.id)] : [];
    const parent = chain.find((e) => e.kind === "region") ?? chain.find((e) => e.kind === "place") ?? null;
    const title = name.trim().replace(/^the\s+/i, "").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
    const id = uniqueId(store, "place", title, taken);
    ops.push({ op: "create_entity", id, kind: "place", name: title, parent: parent?.id ?? null });
    return id;
  };

  for (const p of r.people) {
    const c = known.get(p.id);
    if (!c) continue;
    const sc = charProps(c).scene;
    let to: string | null = null;
    if (p.room && p.room !== c.parent_id && store.getEntity(p.room) && isLocation(store.getEntity(p.room) as Entity)) to = p.room;
    else if (!p.room && p.left_for) to = locate(p.left_for, c);
    if (to && to !== c.parent_id) ops.push({ op: "move", id: c.id, to, ...(p.zone ? { zone: p.zone.toLowerCase().slice(0, 40) } : {}) });
    else if (p.zone && p.zone.toLowerCase() !== (sc.zone ?? "")) ops.push({ op: "set_zone", id: c.id, zone: p.zone.toLowerCase().slice(0, 40) });
    if (p.posture && p.posture.toLowerCase() !== sc.posture.toLowerCase()) ops.push({ op: "set_posture", id: c.id, posture: p.posture.slice(0, 80) });
    if (p.holding) {
      const near = [c.id, to ?? c.parent_id ?? ""].filter(Boolean);
      const want = p.holding.slice(0, 2).map((h) => newItem(h, c.id, near)).filter((x): x is string => !!x);
      const held = [sc.hands.left, sc.hands.right].filter((x): x is string => !!x);
      for (const h of held) if (!want.includes(h)) ops.push({ op: "release", character: c.id, item: h, drop: false });
      for (const w of want) {
        if (held.includes(w)) continue;
        const owner = store.getEntity(w)?.parent_id;
        const other = owner && owner !== c.id ? known.get(owner) : undefined;
        if (other) ops.push({ op: "give", from: other.id, to: c.id, item: w });
        ops.push({ op: "hold", character: c.id, item: w });
      }
    }
  }

  for (const it of r.items) {
    const where = store.getEntity(it.where);
    if (!where) continue;
    const near = [where.id, ...people.map((c) => c.id), ...people.map((c) => c.parent_id ?? "")].filter(Boolean);
    const id = /^new:/i.test(it.id.trim()) ? newItem(it.id, where.id, near) : store.getEntity(it.id.replace(/^\[|\]$/g, "")) ? it.id.replace(/^\[|\]$/g, "") : null;
    if (!id || /^new:/i.test(it.id.trim())) continue;
    const item = store.getEntity(id);
    if (!item || (item.kind !== "item" && item.kind !== "container")) continue;
    if (item.parent_id !== where.id) ops.push({ op: "move", id, to: where.id, ...(it.zone && isLocation(where) ? { zone: it.zone.toLowerCase().slice(0, 40) } : {}) });
  }

  for (const m of r.coins) {
    const c = known.get(m.id);
    const have = c ? coinOf(c) : null;
    if (!c || have === null) continue;
    const delta = m.now !== null ? Math.round(m.now) - have : m.change !== null ? Math.round(m.change) : 0;
    if (!delta) continue;
    if (have + delta < 0) {
      notes.push(`${c.name} can't pay ${-delta} coin with ${have}${m.why ? ` (${m.why})` : ""}`);
      continue;
    }
    ops.push({ op: "resource_delta", character: c.id, resource: "coin", delta });
  }

  const extra = Math.round(r.minutes) - advanced;
  if (extra > 0) ops.push({ op: "time_advance", minutes: Math.min(extra, 1440) });

  const active = store.activeFacts();
  const seen = new Set(active.map((f) => key(f.text)));
  const replaced = new Set<number>();
  for (const d of r.details.slice(0, 6)) {
    if (seen.has(key(d.text))) continue;
    seen.add(key(d.text));
    const replaces = d.replaces && active.some((f) => f.id === d.replaces) && !replaced.has(d.replaces) ? d.replaces : undefined;
    if (replaces) replaced.add(replaces);
    ops.push({ op: "fact", text: d.text, kind: d.kind, subjects: [...new Set(d.subjects.filter((x) => store.getEntity(x)))], ...(replaces ? { replaces } : {}) });
  }

  for (const e of r.earshot) {
    const a = store.getEntity(e.a);
    const b = store.getEntity(e.b);
    if (a?.kind !== "room" || b?.kind !== "room" || a.id === b.id) continue;
    if (roomProps(a).open_to.includes(b.id) !== e.open) ops.push({ op: "earshot", a: a.id, b: b.id, open: e.open });
  }
  return ops;
}

type Chat = { chat(req: ChatRequest): Promise<ChatResult> };

/** Reads a finished passage against the records and returns the ops that bring the records in line with it. */
export async function syncState(
  llm: Chat,
  store: WorldStore,
  playerId: string,
  s: WorldSettings,
  said: string,
  prose: string,
  advanced: number,
  named: Entity[] = [],
): Promise<{ ops: OpInput[]; notes: string[]; cost: number }> {
  if (!prose.trim()) return { ops: [], notes: [], cost: 0 };
  const rec = syncRecords(store, playerId, named);
  const res = await llm.chat({
    model: s.syncModel,
    json: true,
    maxTokens: 1500,
    temperature: 0,
    messages: [
      { role: "system", content: SYNC_PROMPT + (s.corrections.trim() ? `\nPlayer corrections (they override the passage and records): ${s.corrections.trim()}` : "") },
      { role: "user", content: [rec.text, "", ...(said ? [`Protagonist this turn: ${said}`, ""] : []), `Passage:\n${prose}`].join("\n") },
    ],
  });
  let r: SyncResult;
  try {
    r = SyncResult.parse(JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim()));
  } catch {
    return { ops: [], notes: ["state sync reply unreadable"], cost: res.costUsd };
  }
  const notes: string[] = [];
  return { ops: syncOps(store, playerId, r, advanced, rec.people, rec.places, notes), notes, cost: res.costUsd };
}
