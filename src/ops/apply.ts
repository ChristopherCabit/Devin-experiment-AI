import { ZodError } from "zod";
import type { WorldStore } from "../world/store.js";
import {
  ALLOWED_PARENTS,
  CharacterProps,
  ItemProps,
  RoomProps,
  type Entity,
  type EntityKind,
} from "../world/types.js";
import {
  blockedByClosed,
  carrierOf,
  charProps,
  clockMinutes,
  inReach,
  isDescendantOf,
  isLocation,
  itemProps,
  roomProps,
  slugify,
} from "../world/queries.js";
import { memberSheet, seeded } from "../world/variance.js";
import { Appointment, Reference, Secret, Sheet, Thread, WorldEvent } from "../world/types.js";
import { appointments, references, secrets, threads, worldEvents } from "../world/queries.js";
import { AUTHOR_ONLY_OPS, ENGINE_ONLY_OPS, Op, type OpSource } from "./schema.js";

export interface Limits {
  /** Largest single time jump the narrator may propose; larger requests are clamped. */
  maxNarratorMinutes: number;
  /** Inner Self-style brain size per NPC. */
  maxThoughts: number;
}

export const DEFAULT_LIMITS: Limits = { maxNarratorMinutes: 240, maxThoughts: 24 };

export interface ApplyContext {
  source: OpSource;
  turn: number;
  limits?: Partial<Limits>;
}

export type OpResult =
  | { ok: true; op: Op; id?: string; note?: string }
  | { ok: false; op: unknown; reason: string };

class OpError extends Error {}

function omit<T>(rec: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k, v]) => !drop(k, v)));
}

function fail(reason: string): never {
  throw new OpError(reason);
}

interface Done {
  id?: string;
  note?: string;
}

const PORTABLE: EntityKind[] = ["item", "container"];

function need(store: WorldStore, id: string, kinds?: readonly EntityKind[]): Entity {
  const e = store.getEntity(id);
  if (!e) fail(`unknown entity ${id}`);
  if (kinds && !kinds.includes(e.kind)) fail(`${id} is a ${e.kind}, expected ${kinds.join("/")}`);
  return e;
}

/** `into` with any keys it lacks (or has as null) filled from `from`; arrays are unioned. */
function fillMissing(into: unknown, from: unknown): unknown {
  if (Array.isArray(into) && Array.isArray(from)) return [...into, ...from.filter((x) => !into.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
  if (into && from && typeof into === "object" && typeof from === "object" && !Array.isArray(into) && !Array.isArray(from)) {
    const out: Record<string, unknown> = { ...(into as Record<string, unknown>) };
    for (const [k, v] of Object.entries(from)) out[k] = out[k] === undefined || out[k] === null ? v : fillMissing(out[k], v);
    return out;
  }
  return into ?? from;
}

function editChar(store: WorldStore, id: string, fn: (p: CharacterProps, e: Entity) => void): void {
  const e = need(store, id, ["character"]);
  const p = charProps(e);
  fn(p, e);
  store.putEntity({ ...e, props: p });
}

function guardPlayerMind(store: WorldStore, id: string, ctx: ApplyContext): void {
  if (ctx.source === "narrator" && charProps(need(store, id, ["character"])).is_player) {
    fail("the player's mind is not narrator-writable");
  }
}

function checkParent(store: WorldStore, kind: EntityKind, parentId: string | null, movingId?: string): Entity | null {
  if (parentId === null) {
    if (!ALLOWED_PARENTS[kind].includes(null)) fail(`a ${kind} needs a parent`);
    return null;
  }
  const parent = need(store, parentId);
  if (!ALLOWED_PARENTS[kind].includes(parent.kind)) fail(`a ${kind} can't be inside a ${parent.kind}`);
  if (movingId && (parent.id === movingId || isDescendantOf(store, parent.id, movingId))) {
    fail("containment cycle");
  }
  return parent;
}

function ensureZone(store: WorldStore, locationId: string, zone: string): void {
  const loc = need(store, locationId);
  const rp = roomProps(loc);
  if (!rp.zones.includes(zone)) {
    rp.zones.push(zone);
    store.putEntity({ ...loc, props: rp });
  }
}

/** Clears hand/worn references from whoever currently carries the item. */
function detach(store: WorldStore, itemId: string): void {
  const carrier = carrierOf(store, itemId);
  if (!carrier) return;
  editChar(store, carrier.id, (p) => {
    if (p.scene.hands.left === itemId) p.scene.hands.left = null;
    if (p.scene.hands.right === itemId) p.scene.hands.right = null;
    p.scene.worn = omit(p.scene.worn, (_, worn) => worn === itemId);
  });
}

/** Reparents a portable thing, clearing its loose-in-room zone unless given. */
function placeItem(store: WorldStore, itemId: string, parent: Entity, zone: string | null = null): void {
  const item = need(store, itemId);
  const ip: ItemProps = itemProps(item);
  delete ip.zone;
  if (isLocation(parent) && zone !== null) {
    ip.zone = zone;
    ensureZone(store, parent.id, zone);
  }
  store.putEntity({ ...item, parent_id: parent.id, props: ip });
}

/** Character may take `item` into their hands/inventory. */
function checkCanTake(store: WorldStore, charId: string, item: Entity): void {
  const carrier = carrierOf(store, item.id);
  if (carrier && carrier.id !== charId) fail(`${item.name} is carried by ${carrier.name}`);
  if (carrier) {
    if (blockedByClosed(store, item.id, charId)) fail(`${item.name} is inside something closed`);
  } else if (!inReach(store, charId, item.id)) {
    fail(`${item.name} is out of reach`);
  }
}

function freshId(store: WorldStore, kind: EntityKind, name: string): string {
  const base = `${kind}:${slugify(name)}`;
  if (!store.getEntity(base)) return base;
  for (let i = 2; ; i++) if (!store.getEntity(`${base}-${i}`)) return `${base}-${i}`;
}

function conditionsOf(e: Entity): string[] {
  const c = e.props.conditions;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
}

function handle(store: WorldStore, op: Op, ctx: ApplyContext, limits: Limits): Done {
  switch (op.op) {
    case "create_entity": {
      const parent = checkParent(store, op.kind, op.parent);
      let id = op.id;
      if (id) {
        if (!id.startsWith(`${op.kind}:`)) fail("id prefix must match kind");
        if (store.getEntity(id)) fail(`${id} already exists`);
      } else {
        id = freshId(store, op.kind, op.name);
      }
      const zone = op.zone && parent && isLocation(parent) ? op.zone : null;
      let props: Record<string, unknown> = op.props;
      if (op.kind === "character") {
        const cp = CharacterProps.parse(op.props);
        if (ctx.source === "narrator" && cp.is_player) fail("the narrator cannot create a player character");
        cp.scene.zone = zone;
        props = cp;
      } else if (op.kind === "room" || op.kind === "place" || op.kind === "region") {
        props = RoomProps.parse(op.props);
      } else if (PORTABLE.includes(op.kind)) {
        const ip = ItemProps.parse(op.props);
        if (zone) ip.zone = zone;
        else delete ip.zone;
        props = ip;
      }
      if (zone && parent) ensureZone(store, parent.id, zone);
      store.putEntity({
        id,
        kind: op.kind,
        name: op.name,
        aliases: op.aliases,
        parent_id: parent?.id ?? null,
        props,
        created_turn: ctx.turn,
      });
      return { id };
    }

    case "move": {
      const e = need(store, op.id);
      if (e.kind === "faction" || e.kind === "concept") fail(`a ${e.kind} has no location`);
      if (isLocation(e) && ctx.source !== "author") fail("locations can only be moved in author mode");
      const target = checkParent(store, e.kind, op.to, e.id);
      if (!target) fail("move needs a target");
      const zone = isLocation(target) ? (op.zone ?? null) : null;
      if (PORTABLE.includes(e.kind)) {
        detach(store, e.id);
        placeItem(store, e.id, target, zone);
      } else if (e.kind === "character") {
        const p = charProps(e);
        p.scene.zone = zone;
        if (zone) ensureZone(store, target.id, zone);
        store.putEntity({ ...e, parent_id: target.id, props: p });
      } else {
        store.putEntity({ ...e, parent_id: target.id });
      }
      return {};
    }

    case "author_update": {
      const e = need(store, op.id);
      let props = op.props ?? e.props;
      if (e.kind === "character") props = CharacterProps.parse(props);
      else if (isLocation(e)) props = RoomProps.parse(props);
      else if (PORTABLE.includes(e.kind)) props = ItemProps.parse(props);
      store.putEntity({ ...e, name: op.name ?? e.name, aliases: op.aliases ?? e.aliases, props });
      return {};
    }

    case "update_character": {
      editChar(store, op.id, (p, e) => {
        if (ctx.source === "narrator" && p.is_player) fail("the narrator cannot edit the player character");
        if (op.sheet) {
          if (ctx.source === "narrator") fail("sheets are set by the engine");
          p.sheet = Sheet.parse(op.sheet);
        }
        const rec = p as Record<string, unknown>;
        for (const k of ["description", "appearance", "traits", "goals", "backstory"] as const) if (op[k]) rec[k] = op[k];
        for (const path of ["attributes", "skills", "abilities"] as const) {
          for (const [k, v] of Object.entries(op.add_stats?.[path] ?? {})) if (!(k in p.sheet[path])) p.sheet[path][k] = v;
        }
        if (op.aliases) e.aliases = [...new Set([...e.aliases, ...op.aliases])];
      });
      return {};
    }

    case "group_count":
      editChar(store, op.id, (p) => {
        if (!p.group) fail(`${op.id} is not a group`);
        p.group.count = Math.max(0, p.group.count + op.delta);
      });
      return {};

    case "split_member": {
      const g = need(store, op.group, ["character"]);
      const gp = charProps(g);
      if (!gp.group || gp.group.count < 1) fail(`${op.group} has no members left to single out`);
      const id = op.id ?? freshId(store, "character", op.name);
      if (!id.startsWith("character:")) fail("id prefix must match kind");
      if (store.getEntity(id)) fail(`${id} already exists`);
      const base = Object.fromEntries(Object.entries(gp).filter(([k]) => !["group", "mind", "sheet"].includes(k)));
      const extra = Object.fromEntries(Object.entries(op.props).filter(([k]) => !["sheet", "group", "is_player"].includes(k)));
      const props = CharacterProps.parse({
        ...base,
        ...extra,
        sheet: memberSheet(gp.sheet, seeded(`${g.id}|${id}|${gp.group.count}`)),
        group: null,
        member_of: g.id,
      });
      props.scene = { ...props.scene, zone: op.zone ?? gp.scene.zone, hands: { left: null, right: null }, worn: {}, relations: [] };
      store.putEntity({ id, kind: "character", name: op.name, aliases: [], parent_id: g.parent_id, props, created_turn: ctx.turn });
      store.putEntity({ ...g, props: { ...gp, group: { count: gp.group.count - 1 } } });
      return { id };
    }

    case "practice":
      editChar(store, op.character, (p) => {
        p.sheet.progress[op.key] = op.value;
      });
      return {};

    case "remove_entity": {
      const e = need(store, op.id);
      if (e.kind === "character" && charProps(e).is_player) fail("cannot remove the player");
      if (store.children(e.id).length) fail(`${e.name} still contains things`);
      if (PORTABLE.includes(e.kind)) detach(store, e.id);
      store.deleteEntity(e.id);
      return {};
    }

    case "retract_fact": {
      if (ctx.source === "narrator") fail("the narrator cannot retract facts");
      if (!store.facts().some((f) => f.id === op.id)) fail(`no fact #${op.id}`);
      store.deleteFact(op.id);
      return {};
    }

    case "merge_entity": {
      if (ctx.source === "narrator") fail("the narrator cannot merge");
      const from = need(store, op.from);
      const into = need(store, op.into);
      if (from.id === into.id) fail("cannot merge something into itself");
      if (from.kind !== into.kind) fail("can only merge things of the same kind");
      if ((from.props as { is_player?: unknown }).is_player) fail("cannot merge the player away");
      const swap = <T>(v: T): T => JSON.parse(JSON.stringify(v).split(`"${from.id}"`).join(`"${into.id}"`)) as T;
      for (const c of store.children(from.id)) store.putEntity({ ...c, parent_id: into.id });
      let props = swap(fillMissing(into.props, from.props)) as Record<string, unknown>;
      const scene = props.scene as { relations?: { target: string }[] } | undefined;
      if (scene?.relations) scene.relations = scene.relations.filter((r, i, all) => r.target !== into.id && all.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i);
      if (into.kind === "character") props = CharacterProps.parse(props);
      const aliases = [...new Set([...into.aliases, from.name, ...from.aliases])].filter((a) => a.toLowerCase() !== into.name.toLowerCase());
      store.deleteEntity(from.id);
      store.putEntity({ ...into, aliases, props });
      for (const e of store.allEntities()) if (e.id !== into.id && JSON.stringify(e).includes(`"${from.id}"`)) store.putEntity(swap(e));
      for (const key of ["secrets", "threads", "appointments", "world_events"]) {
        const v = store.getMeta<unknown>(key, null);
        if (v !== null && JSON.stringify(v).includes(`"${from.id}"`)) store.setMeta(key, swap(v));
      }
      for (const f of store.facts()) if (f.subjects.includes(from.id)) store.setFactSubjects(f.id, [...new Set(f.subjects.map((s) => (s === from.id ? into.id : s)))]);
      return {};
    }

    case "rename": {
      const e = need(store, op.id);
      if (ctx.source === "narrator" && (e.props as { is_player?: unknown }).is_player) fail("the narrator cannot rename the player character");
      if (e.name.toLowerCase() === op.name.toLowerCase()) fail(`${op.id} is already named ${op.name}`);
      const taken = ctx.source === "narrator" && store.entitiesOfKind(e.kind).find((x) => x.id !== e.id && x.name.toLowerCase() === op.name.toLowerCase());
      if (taken) fail(`${op.name} is already ${taken.id}; a duplicate is merged by the player, not renamed`);
      const aliases = [...new Set([...e.aliases, e.name])].filter((a) => a.toLowerCase() !== op.name.toLowerCase());
      store.putEntity({ ...e, name: op.name, aliases });
      return {};
    }

    case "secret": {
      for (const id of [...op.subjects, ...op.known_by]) need(store, id);
      const list = secrets(store);
      const id = `secret:${1 + Math.max(0, ...list.map((x) => Number(x.id.split(":")[1]) || 0))}`;
      list.push(Secret.parse({ ...op, id, created_turn: ctx.turn }));
      store.setMeta("secrets", list);
      return { id };
    }

    case "reveal":
    case "hint":
    case "secret_urgency": {
      const list = secrets(store);
      const sec = list.find((x) => x.id === op.id);
      if (!sec) fail(`unknown secret ${op.id}`);
      if (op.op === "reveal") {
        if (sec.revealed) fail(`${op.id} is already known`);
        sec.revealed = true;
        sec.revealed_turn = ctx.turn;
      } else if (op.op === "hint") sec.hinted_turn = ctx.turn;
      else sec.urgency = op.to;
      store.setMeta("secrets", list);
      return {};
    }

    case "thread": {
      for (const id of op.participants) need(store, id);
      if (op.place) need(store, op.place);
      const list = threads(store);
      if (list.some((t) => t.status === "open" && t.title.toLowerCase() === op.title.toLowerCase())) fail(`thread "${op.title}" already open`);
      const id = `thread:${1 + Math.max(0, ...list.map((x) => Number(x.id.split(":")[1]) || 0))}`;
      const deadline = op.deadline_hours ? clockMinutes(store) + Math.round(op.deadline_hours * 60) : null;
      const rest = { title: op.title, text: op.text, participants: op.participants, place: op.place, urgency: op.urgency, known: op.known };
      list.push(Thread.parse({ ...rest, id, deadline, created_turn: ctx.turn, touched_turn: ctx.turn }));
      store.setMeta("threads", list);
      return { id };
    }

    case "thread_update": {
      const list = threads(store);
      const t = list.find((x) => x.id === op.id);
      if (!t) fail(`unknown thread ${op.id}`);
      if (op.status) t.status = op.status;
      if (op.urgency) t.urgency = op.urgency;
      if (op.known !== undefined) t.known = op.known;
      if (op.note) t.notes = [...t.notes, op.note].slice(-6);
      t.touched_turn = ctx.turn;
      store.setMeta("threads", list);
      return {};
    }

    case "reference": {
      const list = references(store).filter((r) => r.subject.toLowerCase() !== op.subject.toLowerCase());
      list.push(Reference.parse({ subject: op.subject, note: op.note, turn: ctx.turn }));
      store.setMeta("references", list.slice(-100));
      return {};
    }

    case "appointment": {
      for (const id of op.who) need(store, id);
      const now = clockMinutes(store);
      const key = op.text.toLowerCase();
      const list = appointments(store).filter((a) => a.text.toLowerCase() !== key && a.at >= now - 1440);
      list.push(Appointment.parse({ text: op.text, at: op.at, who: op.who, created_turn: ctx.turn }));
      store.setMeta("appointments", list.sort((a, b) => a.at - b.at).slice(-12));
      return {};
    }

    case "appointment_update": {
      const list = appointments(store);
      const i = list.findIndex((a) => a.text.toLowerCase() === op.text.toLowerCase());
      const a = list[i];
      if (!a) return {};
      if (op.status === "moved" && op.at !== null) list[i] = { ...a, was: a.was ?? a.at, at: op.at };
      else list.splice(i, 1);
      store.setMeta("appointments", list.sort((x, y) => x.at - y.at));
      return {};
    }

    case "world_event": {
      if (op.origin) need(store, op.origin);
      const list = worldEvents(store);
      const id = `event:${1 + Math.max(0, ...list.map((x) => Number(x.id.split(":")[1]) || 0))}`;
      list.push(WorldEvent.parse({ id, text: op.text, reach: op.reach, origin: op.origin, at: clockMinutes(store), created_turn: ctx.turn }));
      store.setMeta("world_events", list.slice(-30));
      return { id };
    }

    case "life_event": {
      const e = need(store, op.npc, ["character"]);
      const life = Array.isArray(e.props.life) ? (e.props.life as unknown[]) : [];
      store.putEntity({ ...e, props: { ...e.props, life: [...life, { text: op.text, at: clockMinutes(store) }].slice(-4) } });
      return {};
    }

    case "life_tick": {
      store.setMeta("life_tick", clockMinutes(store));
      return {};
    }

    case "set_zone": {
      const e = need(store, op.id, ["character", ...PORTABLE]);
      const parent = e.parent_id ? store.getEntity(e.parent_id) : null;
      if (!parent || !isLocation(parent)) fail(`${e.name} is not directly in a room`);
      ensureZone(store, parent.id, op.zone);
      if (e.kind === "character") {
        editChar(store, e.id, (p) => {
          p.scene.zone = op.zone;
        });
      } else {
        store.putEntity({ ...e, props: { ...itemProps(e), zone: op.zone } });
      }
      return {};
    }

    case "set_posture":
      editChar(store, op.id, (p) => {
        p.scene.posture = op.posture;
      });
      return {};

    case "hold": {
      const c = need(store, op.character, ["character"]);
      const item = need(store, op.item, PORTABLE);
      const p = charProps(c);
      if (p.scene.hands.left === item.id || p.scene.hands.right === item.id) return { note: "already held" };
      if (Object.values(p.scene.worn).includes(item.id)) fail(`${item.name} is worn; remove it first`);
      checkCanTake(store, c.id, item);
      const hand = op.hand ?? (p.scene.hands.right === null ? "right" : p.scene.hands.left === null ? "left" : null);
      if (!hand) fail("both hands are full");
      if (p.scene.hands[hand] !== null) fail(`${hand} hand is already holding something`);
      if (item.parent_id !== c.id) placeItem(store, item.id, c);
      editChar(store, c.id, (cp) => {
        cp.scene.hands[hand] = item.id;
      });
      return {};
    }

    case "release": {
      const c = need(store, op.character, ["character"]);
      const item = need(store, op.item, PORTABLE);
      const p = charProps(c);
      const held = p.scene.hands.left === item.id || p.scene.hands.right === item.id;
      const carried = carrierOf(store, item.id)?.id === c.id;
      if (!held && !(op.drop && carried)) fail(`${c.name} isn't holding ${item.name}`);
      if (op.drop && Object.values(p.scene.worn).includes(item.id)) fail(`${item.name} is worn; remove it first`);
      detach(store, item.id);
      if (op.drop) {
        const where = c.parent_id ? need(store, c.parent_id) : null;
        if (!where) fail(`${c.name} is nowhere`);
        placeItem(store, item.id, where, isLocation(where) ? p.scene.zone : null);
      }
      return {};
    }

    case "wear": {
      const c = need(store, op.character, ["character"]);
      const item = need(store, op.item, PORTABLE);
      const slot = op.slot ?? itemProps(item).slot;
      if (!slot) fail(`${item.name} has no worn slot`);
      const current = charProps(c).scene.worn[slot];
      if (current === item.id) return { note: "already worn" };
      if (current) fail(`${slot} slot is already occupied`);
      checkCanTake(store, c.id, item);
      detach(store, item.id);
      if (item.parent_id !== c.id) placeItem(store, item.id, c);
      editChar(store, c.id, (p) => {
        p.scene.worn[slot] = item.id;
      });
      return {};
    }

    case "unwear":
      editChar(store, op.character, (p) => {
        if (!p.scene.worn[op.slot]) fail(`nothing worn in ${op.slot}`);
        p.scene.worn = omit(p.scene.worn, (slot) => slot === op.slot);
      });
      return {};

    case "give": {
      const from = need(store, op.from, ["character"]);
      const to = need(store, op.to, ["character"]);
      const item = need(store, op.item, PORTABLE);
      if (from.id === to.id) fail("cannot give to self");
      if (carrierOf(store, item.id)?.id !== from.id) fail(`${from.name} doesn't have ${item.name}`);
      if (Object.values(charProps(from).scene.worn).includes(item.id)) fail(`${item.name} is worn; remove it first`);
      if (!inReach(store, from.id, to.id)) fail(`${to.name} is out of reach`);
      detach(store, item.id);
      placeItem(store, item.id, to);
      return {};
    }

    case "set_condition": {
      const e = need(store, op.id, ["character", ...PORTABLE]);
      if (op.remove.length && ctx.source === "narrator" && e.kind === "character" && charProps(e).is_player) {
        fail("the narrator cannot remove the player's conditions");
      }
      const next = conditionsOf(e).filter((c) => !op.remove.includes(c));
      for (const c of op.add) if (!next.includes(c)) next.push(c);
      store.putEntity({ ...e, props: { ...e.props, conditions: next } });
      return {};
    }

    case "relation": {
      for (const r of [...op.add, ...op.remove]) need(store, r.target);
      editChar(store, op.id, (p) => {
        const same = (a: { type: string; target: string }, b: { type: string; target: string }) =>
          a.type === b.type && a.target === b.target;
        p.scene.relations = p.scene.relations.filter((r) => !op.remove.some((x) => same(r, x)));
        for (const r of op.add) if (!p.scene.relations.some((x) => same(r, x))) p.scene.relations.push(r);
      });
      return {};
    }

    case "emotion":
      guardPlayerMind(store, op.npc, ctx);
      editChar(store, op.npc, (p) => {
        p.mind.emotions = [...new Set(op.set)];
      });
      return {};

    case "opinion":
      editChar(store, op.id, (p) => {
        if (p.is_player) fail("the protagonist's opinions are the player's");
        const rec = p as Record<string, unknown>;
        const key = op.topic.toLowerCase();
        const held = Object.entries((rec.opinions as Record<string, string> | undefined) ?? {}).filter(([k]) => k.toLowerCase() !== key);
        rec.opinions = Object.fromEntries([...held, [op.topic, op.why ? `${op.view} (changed because ${op.why})` : op.view]].slice(-12));
      });
      return {};

    case "thought":
      guardPlayerMind(store, op.npc, ctx);
      editChar(store, op.npc, (p) => {
        const isNew = !(op.key in p.mind.thoughts);
        const keys = Object.keys(p.mind.thoughts);
        if (isNew && keys.length >= limits.maxThoughts) {
          p.mind.thoughts = Object.fromEntries(Object.entries(p.mind.thoughts).slice(keys.length - limits.maxThoughts + 1));
        }
        p.mind.thoughts[op.key] = op.text;
      });
      return {};

    case "forget_thought":
      guardPlayerMind(store, op.npc, ctx);
      editChar(store, op.npc, (p) => {
        if (!(op.key in p.mind.thoughts)) fail(`no thought ${op.key}`);
        p.mind.thoughts = omit(p.mind.thoughts, (key) => key === op.key);
      });
      return {};

    case "relationship_note":
      guardPlayerMind(store, op.npc, ctx);
      need(store, op.target);
      editChar(store, op.npc, (p) => {
        p.mind.relationship_notes[op.target] = op.text;
      });
      return {};

    case "fact": {
      for (const s of op.subjects) need(store, s);
      const id = store.addFact(op.text, op.subjects, ctx.turn);
      return { id: `fact:${id}` };
    }

    case "time_advance": {
      let minutes = op.minutes;
      let note: string | undefined;
      if (ctx.source === "narrator" && minutes > limits.maxNarratorMinutes) {
        minutes = limits.maxNarratorMinutes;
        note = `clamped to ${minutes} minutes`;
      }
      store.setMeta("clock_minutes", clockMinutes(store) + minutes);
      return note ? { note } : {};
    }

    case "resource_delta":
      editChar(store, op.character, (p) => {
        const r = p.sheet.resources[op.resource];
        if (!r) fail(`no resource ${op.resource}`);
        r.value = Math.min(r.max, Math.max(r.min, r.value + op.delta));
      });
      return {};

    case "progression":
      editChar(store, op.character, (p) => {
        if (op.path === "power_tier") {
          p.sheet.power_tier = op.to;
          return;
        }
        if (!op.key) fail("progression needs a key");
        p.sheet[op.path][op.key] = op.to;
      });
      return {};
  }
}

/**
 * Validates one op against schema and state, then applies it atomically.
 * Rejections never throw; they leave state untouched and carry a reason.
 */
export function applyOp(store: WorldStore, raw: unknown, ctx: ApplyContext): OpResult {
  const parsed = Op.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "op"}: ${i.message}`).join("; ");
    return { ok: false, op: raw, reason: `invalid op: ${reason}` };
  }
  const op = parsed.data;
  const narratorSpend = op.op === "resource_delta" && op.delta < 0 && op.resource !== "hp";
  if (ctx.source === "narrator" && ENGINE_ONLY_OPS.has(op.op) && !narratorSpend) {
    return { ok: false, op, reason: `${op.op} is engine-only` };
  }
  if (ctx.source !== "author" && AUTHOR_ONLY_OPS.has(op.op)) {
    return { ok: false, op, reason: `${op.op} is author-only` };
  }
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  try {
    const done = store.transaction(() => handle(store, op, ctx, limits));
    return { ok: true, op, ...done };
  } catch (e) {
    if (e instanceof OpError) return { ok: false, op, reason: e.message };
    if (e instanceof ZodError) return { ok: false, op, reason: `invalid props: ${e.issues[0]?.message ?? "?"}` };
    throw e;
  }
}

export function applyOps(store: WorldStore, raws: readonly unknown[], ctx: ApplyContext): OpResult[] {
  return raws.map((r) => applyOp(store, r, ctx));
}
