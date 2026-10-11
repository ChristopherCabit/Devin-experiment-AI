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
});
export type Sheet = z.infer<typeof Sheet>;

export const CharacterProps = z
  .object({
    is_player: z.boolean().default(false),
    age: z.number().int().positive().nullable().default(null),
    scene: SceneState.default({}),
    mind: Mind.default({}),
    sheet: Sheet.default({}),
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
