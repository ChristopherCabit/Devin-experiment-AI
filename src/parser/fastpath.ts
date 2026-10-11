import type { OpInput } from "../ops/schema.js";
import type { WorldStore } from "../world/store.js";
import type { Entity } from "../world/types.js";
import { charProps, inReach, itemProps, isLocation, roomProps, zoneOf } from "../world/queries.js";

/**
 * Deterministic parser for common verbs. Returns `null` whenever it is not
 * certain, so the input falls through to the LLM parser. It only returns
 * `fail` for concrete contradictions with recorded, visible state.
 */
export type FastPathResult =
  | { kind: "ops"; action: string; ops: OpInput[] }
  | { kind: "look" }
  | { kind: "fail"; action: string; reason: string };

const ARTICLES = /^(?:the|a|an|my|your|some|this|that)\s+/;
const RESTRAINT = /restrain|tied|bound|pinned|held_by|grappled/;

export function normalizeName(s: string): string {
  let t = s.toLowerCase().trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  while (ARTICLES.test(t)) t = t.replace(ARTICLES, "");
  return t;
}

function cleanInput(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^(?:i|you)\s+/, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ");
}

interface Candidate {
  e: Entity;
  /** Lower is closer: 0 held, 1 carried/worn, 2 same zone, 3 elsewhere in room. */
  rank: number;
  carried: boolean;
  carriedByOther: boolean;
}

const PORTABLE = new Set(["item", "container"]);
const isClosed = (e: Entity) => PORTABLE.has(e.kind) && itemProps(e).closed === true;

function scope(store: WorldStore, player: Entity): Candidate[] {
  const p = charProps(player);
  const held = new Set([p.scene.hands.left, p.scene.hands.right].filter((x): x is string => x !== null));
  const out: Candidate[] = [];

  const walkCarried = (parentId: string, carrierIsPlayer: boolean) => {
    for (const child of store.children(parentId)) {
      out.push({
        e: child,
        rank: carrierIsPlayer ? (held.has(child.id) ? 0 : 1) : 4,
        carried: carrierIsPlayer,
        carriedByOther: !carrierIsPlayer,
      });
      if (!isClosed(child)) walkCarried(child.id, carrierIsPlayer);
    }
  };
  walkCarried(player.id, true);

  const here = player.parent_id ? store.getEntity(player.parent_id) : null;
  if (!here) return out;
  const myZone = p.scene.zone;
  const walkRoom = (parentId: string) => {
    for (const child of store.children(parentId)) {
      if (child.id === player.id) continue;
      if (child.kind === "character") {
        if (charProps(child).scene.hidden) continue;
        out.push({ e: child, rank: 3, carried: false, carriedByOther: false });
        walkCarried(child.id, false);
        continue;
      }
      if (!PORTABLE.has(child.kind)) continue;
      const zone = zoneOf(store, child.id);
      out.push({ e: child, rank: zone !== null && zone === myZone ? 2 : 3, carried: false, carriedByOther: false });
      if (!isClosed(child)) walkRoom(child.id);
    }
  };
  walkRoom(here.id);
  return out;
}

type Resolved = { found: Candidate } | { found: null; ambiguous: boolean };

function resolve(cands: Candidate[], name: string, filter: (c: Candidate) => boolean = () => true): Resolved {
  const n = normalizeName(name);
  const matches = cands
    .filter(filter)
    .filter((c) => normalizeName(c.e.name) === n || c.e.aliases.some((a) => normalizeName(a) === n))
    .sort((a, b) => a.rank - b.rank);
  const [first, second] = matches;
  if (!first) return { found: null, ambiguous: false };
  if (second && second.rank === first.rank) return { found: null, ambiguous: true };
  return { found: first };
}

const isPortable = (c: Candidate) => PORTABLE.has(c.e.kind);

export function fastPath(store: WorldStore, playerId: string, input: string): FastPathResult | null {
  const player = store.getEntity(playerId);
  if (!player || player.kind !== "character") throw new Error(`no player ${playerId}`);
  const p = charProps(player);
  const text = cleanInput(input);
  if (!text) return null;

  if (/^(?:look|l|look around)$/.test(text)) return { kind: "look" };

  let m: RegExpExecArray | null;
  if ((m = /^(?:wait|rest)(?:\s+(?:for\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h))?$/.exec(text))) {
    const n = m[1] ? Number(m[1]) : 10;
    const minutes = m[2]?.startsWith("h") ? n * 60 : n;
    if (minutes <= 0) return null;
    return { kind: "ops", action: `wait ${minutes} minutes`, ops: [{ op: "time_advance", minutes }] };
  }
  if (text === "sleep") {
    return {
      kind: "ops",
      action: "sleep",
      ops: [
        { op: "set_posture", id: playerId, posture: "lying" },
        { op: "time_advance", minutes: 480 },
      ],
    };
  }

  // Anything physical while restrained is a risky action, not a fast-path one.
  if (p.scene.relations.some((r) => RESTRAINT.test(r.type))) return null;

  const cands = scope(store, player);
  const approach = (target: Candidate): OpInput[] => {
    const zone = zoneOf(store, target.e.id);
    return !inReach(store, playerId, target.e.id) && zone ? [{ op: "set_zone", id: playerId, zone }] : [];
  };
  const wornSlot = (id: string) => Object.entries(p.scene.worn).find(([, w]) => w === id)?.[0];

  if ((m = /^(?:take off|remove)\s+(.+)$/.exec(text))) {
    const r = resolve(cands, m[1] ?? "", (c) => c.carried);
    if (!r.found) return null;
    const slot = wornSlot(r.found.e.id);
    if (!slot) return { kind: "fail", action: text, reason: `You aren't wearing the ${r.found.e.name}.` };
    return { kind: "ops", action: `remove ${r.found.e.name}`, ops: [{ op: "unwear", character: playerId, slot }] };
  }

  if ((m = /^(?:put on|wear)\s+(.+)$/.exec(text)) || (m = /^put\s+(.+?)\s+on$/.exec(text))) {
    const r = resolve(cands, m[1] ?? "", isPortable);
    if (!r.found || r.found.carriedByOther || !itemProps(r.found.e).slot) return null;
    if (wornSlot(r.found.e.id)) return { kind: "fail", action: text, reason: `You're already wearing the ${r.found.e.name}.` };
    return {
      kind: "ops",
      action: `wear ${r.found.e.name}`,
      ops: [...(r.found.carried ? [] : approach(r.found)), { op: "wear", character: playerId, item: r.found.e.id }],
    };
  }

  if ((m = /^(?:give|hand)\s+(.+?)\s+to\s+(.+)$/.exec(text))) {
    const target = resolve(cands, m[2] ?? "", (c) => c.e.kind === "character");
    if (!target.found) return null;
    const item = resolve(cands, m[1] ?? "", isPortable);
    if (!item.found || item.found.carriedByOther) return null;
    if (!item.found.carried) return { kind: "fail", action: text, reason: `You aren't carrying the ${item.found.e.name}.` };
    if (wornSlot(item.found.e.id)) {
      return { kind: "fail", action: text, reason: `You're wearing the ${item.found.e.name}; take it off first.` };
    }
    return {
      kind: "ops",
      action: `give ${item.found.e.name} to ${target.found.e.name}`,
      ops: [...approach(target.found), { op: "give", from: playerId, to: target.found.e.id, item: item.found.e.id }],
    };
  }

  if ((m = /^(?:take|grab|get|pick up)\s+(.+)$/.exec(text)) || (m = /^pick\s+(.+?)\s+up$/.exec(text))) {
    const name = m[1] ?? "";
    if (/\s(?:from|off|out of)\s/.test(name)) return null;
    const r = resolve(cands, name, isPortable);
    if (!r.found || r.found.carriedByOther || itemProps(r.found.e).fixed === true) return null;
    if (r.found.carried) return { kind: "fail", action: text, reason: `You already have the ${r.found.e.name}.` };
    const handFree = p.scene.hands.left === null || p.scene.hands.right === null;
    const take: OpInput = handFree
      ? { op: "hold", character: playerId, item: r.found.e.id }
      : { op: "move", id: r.found.e.id, to: playerId };
    return { kind: "ops", action: `take ${r.found.e.name}`, ops: [...approach(r.found), take] };
  }

  if ((m = /^(?:drop|put down)\s+(.+)$/.exec(text)) || (m = /^put\s+(.+?)\s+down$/.exec(text))) {
    const r = resolve(cands, m[1] ?? "", isPortable);
    if (!r.found || r.found.carriedByOther) return null;
    if (!r.found.carried) return { kind: "fail", action: text, reason: `You aren't carrying the ${r.found.e.name}.` };
    if (wornSlot(r.found.e.id)) {
      return { kind: "fail", action: text, reason: `You're wearing the ${r.found.e.name}; take it off first.` };
    }
    return {
      kind: "ops",
      action: `drop ${r.found.e.name}`,
      ops: [{ op: "release", character: playerId, item: r.found.e.id, drop: true }],
    };
  }

  if (
    (m = /^(?:go|walk|head|move|run)\s+(?:(?:to|into|in|over to|toward|towards|back to)\s+)?(.+)$/.exec(text)) ||
    (m = /^enter\s+(.+)$/.exec(text))
  ) {
    return go(store, player, cands, m[1] ?? "");
  }

  return null;
}

function go(store: WorldStore, player: Entity, cands: Candidate[], target: string): FastPathResult | null {
  const here = player.parent_id ? store.getEntity(player.parent_id) : null;
  if (!here || !isLocation(here)) return null;
  const name = normalizeName(target);
  const myZone = charProps(player).scene.zone;

  const zone = roomProps(here).zones.find((z) => normalizeName(z) === name);
  if (zone) {
    if (zone === myZone) return { kind: "fail", action: `go to ${zone}`, reason: "You're already there." };
    return { kind: "ops", action: `go to ${zone}`, ops: [{ op: "set_zone", id: player.id, zone }] };
  }

  const thing = resolve(cands, name, (c) => !c.carried && !c.carriedByOther);
  if (thing.found) {
    const z = zoneOf(store, thing.found.e.id);
    if (!z) return null;
    if (z === myZone) return { kind: "fail", action: `go to ${thing.found.e.name}`, reason: "You're already there." };
    return { kind: "ops", action: `go to ${thing.found.e.name}`, ops: [{ op: "set_zone", id: player.id, zone: z }] };
  }
  if (thing.ambiguous) return null;

  const rooms = store.entitiesOfKind("room").filter((r) => [r.name, ...r.aliases].some((x) => normalizeName(x) === name));
  if (rooms.some((r) => r.id === here.id)) {
    return { kind: "fail", action: `go to ${here.name}`, reason: `You're already in the ${here.name}.` };
  }
  const exits = roomProps(here).exits;
  const reachable = rooms.filter((r) =>
    exits.length ? exits.includes(r.id) : r.parent_id !== null && r.parent_id === here.parent_id,
  );
  const [dest, other] = reachable;
  if (!dest || other) return null;
  return {
    kind: "ops",
    action: `go to ${dest.name}`,
    ops: [
      { op: "move", id: player.id, to: dest.id },
      { op: "time_advance", minutes: 1 },
    ],
  };
}
