import { z } from "zod";

export const ENTITY_KINDS = [
  "region",
  "place",
  "room",
  "container",
  "item",
  "character",
  "faction",
  "concept",
] as const;
export const EntityKind = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKind>;

export const EntityId = z.string().regex(/^[a-z]+:[a-z0-9_-]+$/, "id must look like kind:slug");
export type EntityId = z.infer<typeof EntityId>;

/** Which kinds may directly contain which. `null` = may be a root. */
export const ALLOWED_PARENTS: Record<EntityKind, readonly (EntityKind | null)[]> = {
  region: [null, "region"],
  place: [null, "region", "place"],
  room: ["place", "room"],
  container: ["place", "room", "container", "character", "item"],
  item: ["place", "room", "container", "character", "item"],
  character: ["place", "room", "container"],
  faction: [null],
  concept: [null],
};

export const LOCATION_KINDS: readonly EntityKind[] = ["region", "place", "room"];

export const Tier = z.number().int().min(0).max(10);

export const Relation = z.object({ type: z.string().min(1), target: EntityId });
export type Relation = z.infer<typeof Relation>;

export const Hand = z.enum(["left", "right"]);
export type Hand = z.infer<typeof Hand>;

export const SceneState = z.object({
  zone: z.string().nullable().default(null),
  posture: z.string().default("standing"),
  hands: z
    .object({ left: EntityId.nullable().default(null), right: EntityId.nullable().default(null) })
    .default({}),
  worn: z.record(z.string(), EntityId).default({}),
  relations: z.array(Relation).default([]),
  hidden: z.boolean().default(false),
});
export type SceneState = z.infer<typeof SceneState>;

export const Mind = z.object({
  emotions: z.array(z.string()).default([]),
  thoughts: z.record(z.string(), z.string()).default({}),
  relationship_notes: z.record(EntityId, z.string()).default({}),
});
export type Mind = z.infer<typeof Mind>;

export const Resource = z.object({ value: z.number(), min: z.number().default(0), max: z.number() });
export type Resource = z.infer<typeof Resource>;

export const Sheet = z.object({
  attributes: z.record(z.string(), Tier).default({}),
  skills: z.record(z.string(), Tier).default({}),
  abilities: z.record(z.string(), Tier).default({}),
  power_tier: Tier.default(1),
  resources: z.record(z.string(), Resource).default({}),
  /** Practice toward the next tier, per attribute/skill/ability. */
  progress: z.record(z.string(), z.number()).default({}),
});
export type Sheet = z.infer<typeof Sheet>;

export const CharacterProps = z
  .object({
    is_player: z.boolean().default(false),
    age: z.number().int().positive().nullable().default(null),
    scene: SceneState.default({}),
    mind: Mind.default({}),
    sheet: Sheet.default({}),
    /** Set when this entity stands for several identical individuals (a squad, a gang, an army). */
    group: z.object({ count: z.number().int().min(0) }).nullable().default(null),
  })
  .passthrough();
export type CharacterProps = z.infer<typeof CharacterProps>;

export const RoomProps = z
  .object({
    zones: z.array(z.string()).default([]),
    /** Pairs of zones that are within reach of each other. */
    adjacent: z.array(z.tuple([z.string(), z.string()])).default([]),
    /** Room ids reachable directly from this room. Empty = not recorded. */
    exits: z.array(EntityId).default([]),
  })
  .passthrough();
export type RoomProps = z.infer<typeof RoomProps>;

export const ItemProps = z
  .object({
    conditions: z.array(z.string()).default([]),
    /** Worn slot this item fits, if wearable. */
    slot: z.string().optional(),
    /** For containers: closed containers hide and block access to contents. */
    closed: z.boolean().optional(),
    owner: EntityId.optional(),
    /** Furniture and fixtures: never taken by the fast path. */
    fixed: z.boolean().optional(),
    /** Zone within the room where a loose item lies. */
    zone: z.string().nullable().optional(),
    /** Bonus to these stats while held or worn. */
    grants: z.record(z.string(), z.number().int().min(-3).max(3)).optional(),
    /** Stats raised to at least these tiers when the item is used up (tome, potion). */
    teaches: z.record(z.string(), Tier).optional(),
    consumable: z.boolean().optional(),
  })
  .passthrough();
export type ItemProps = z.infer<typeof ItemProps>;

export const Entity = z.object({
  id: EntityId,
  kind: EntityKind,
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  parent_id: EntityId.nullable().default(null),
  props: z.record(z.string(), z.unknown()).default({}),
  created_turn: z.number().int().nonnegative().default(0),
});
export type Entity = z.infer<typeof Entity>;

export const Fact = z.object({
  id: z.number().int(),
  text: z.string().min(1),
  subjects: z.array(EntityId).default([]),
  turn: z.number().int().nonnegative(),
});
export type Fact = z.infer<typeof Fact>;

export const SECRET_KINDS = ["boon", "danger", "horror", "twist"] as const;
export const URGENCIES = ["dormant", "stirring", "active"] as const;
/** Hidden truth the protagonist hasn't learned. Scoped to its subjects (none = the whole world). */
export const Secret = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  kind: z.enum(SECRET_KINDS).catch("twist"),
  subjects: z.array(EntityId).default([]),
  known_by: z.array(EntityId).default([]),
  urgency: z.enum(URGENCIES).catch("dormant"),
  revealed: z.boolean().default(false),
  revealed_turn: z.number().int().nullable().default(null),
  hinted_turn: z.number().int().nullable().default(null),
  created_turn: z.number().int().default(0),
});
export type Secret = z.infer<typeof Secret>;

export const THREAD_STATUS = ["open", "resolved", "abandoned"] as const;
export const THREAD_URGENCY = ["low", "rising", "urgent"] as const;
/** An unresolved situation: a debt, promise, threat, request, rivalry or mystery. Deadline is in clock minutes. */
export const Thread = z.object({
  id: z.string(),
  title: z.string().min(1).max(120),
  text: z.string().max(1000).default(""),
  participants: z.array(EntityId).default([]),
  place: EntityId.nullable().default(null),
  status: z.enum(THREAD_STATUS).catch("open"),
  urgency: z.enum(THREAD_URGENCY).catch("low"),
  deadline: z.number().int().nullable().default(null),
  known: z.boolean().default(true),
  notes: z.array(z.string()).default([]),
  created_turn: z.number().int().default(0),
  touched_turn: z.number().int().default(0),
});
export type Thread = z.infer<typeof Thread>;

export const REACHES = ["local", "regional", "world"] as const;
/** Something happening in the wider world. News of it spreads from its origin at a pace set by the world's connectedness. */
export const WorldEvent = z.object({
  id: z.string(),
  text: z.string().min(1).max(600),
  reach: z.enum(REACHES).catch("local"),
  origin: EntityId.nullable().default(null),
  at: z.number().int().default(0),
  created_turn: z.number().int().default(0),
});
export type WorldEvent = z.infer<typeof WorldEvent>;
