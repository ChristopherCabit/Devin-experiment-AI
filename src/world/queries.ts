import type { WorldStore } from "./store.js";
import {
  Secret,
  CharacterProps,
  ItemProps,
  LOCATION_KINDS,
  RoomProps,
  type Entity,
} from "./types.js";

export const charProps = (e: Entity): CharacterProps => CharacterProps.parse(e.props);
export const itemProps = (e: Entity): ItemProps => ItemProps.parse(e.props);
export const roomProps = (e: Entity): RoomProps => RoomProps.parse(e.props);

export const isLocation = (e: Entity): boolean => LOCATION_KINDS.includes(e.kind);

export function clockMinutes(store: WorldStore): number {
  return store.getMeta("clock_minutes", 0);
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "x";
}

/** Parent first, root last. */
export function ancestors(store: WorldStore, id: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>([id]);
  let cur = store.getEntity(id);
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = store.getEntity(cur.parent_id);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export function isDescendantOf(store: WorldStore, id: string, ancestorId: string): boolean {
  return ancestors(store, id).some((a) => a.id === ancestorId);
}

/** Nearest region/place/room containing `id` (or `id` itself if it is one). */
export function locationOf(store: WorldStore, id: string): Entity | null {
  const self = store.getEntity(id);
  if (!self) return null;
  if (isLocation(self)) return self;
  return ancestors(store, id).find(isLocation) ?? null;
}

/** Nearest character whose inventory contains `id`, below the location. */
export function carrierOf(store: WorldStore, id: string): Entity | null {
  for (const a of ancestors(store, id)) {
    if (isLocation(a)) return null;
    if (a.kind === "character") return a;
  }
  return null;
}

const isClosed = (e: Entity): boolean =>
  (e.kind === "container" || e.kind === "item") && itemProps(e).closed === true;

/** True if a closed container sits between `id` and `stopAt` (both exclusive). */
export function blockedByClosed(store: WorldStore, id: string, stopAt: string): boolean {
  for (const a of ancestors(store, id)) {
    if (a.id === stopAt) return false;
    if (isClosed(a)) return true;
  }
  return false;
}

/** Zone within the room; null when unrecorded. */
export function zoneOf(store: WorldStore, id: string): string | null {
  let cur = store.getEntity(id);
  while (cur && !isLocation(cur)) {
    if (cur.kind === "character") return charProps(cur).scene.zone;
    const parent = cur.parent_id ? store.getEntity(cur.parent_id) : null;
    if (!parent || isLocation(parent)) return itemProps(cur).zone ?? null;
    cur = parent;
  }
  return null;
}

export function zonesAdjacent(room: Entity, a: string, b: string): boolean {
  if (a === b) return true;
  return roomProps(room).adjacent.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** Same location, not sealed away, and same/adjacent zone. Unrecorded zones never block. */
export function inReach(store: WorldStore, actorId: string, targetId: string): boolean {
  const la = locationOf(store, actorId);
  const lt = locationOf(store, targetId);
  if (!la || !lt || la.id !== lt.id) return false;
  if (blockedByClosed(store, targetId, la.id)) return false;
  const za = zoneOf(store, actorId);
  const zt = zoneOf(store, targetId);
  if (za === null || zt === null) return true;
  return zonesAdjacent(la, za, zt);
}

export function canSee(store: WorldStore, viewerId: string, targetId: string): boolean {
  const lv = locationOf(store, viewerId);
  const lt = locationOf(store, targetId);
  if (!lv || !lt || lv.id !== lt.id) return false;
  const target = store.getEntity(targetId);
  if (target?.kind === "character" && charProps(target).scene.hidden) return false;
  return !blockedByClosed(store, targetId, lv.id);
}

export const secrets = (store: WorldStore): Secret[] => Secret.array().catch([]).parse(store.getMeta<unknown>("secrets", []));
