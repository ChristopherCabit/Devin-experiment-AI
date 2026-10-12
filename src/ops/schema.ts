import { z } from "zod";
import { EntityId, EntityKind, Hand, Relation, SECRET_KINDS, Tier, URGENCIES } from "../world/types.js";

const Name = z.string().trim().min(1).max(80);
const Zone = z.string().trim().toLowerCase().min(1).max(40);
const Text = z.string().trim().min(1).max(500);

export const Op = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create_entity"),
      id: EntityId.optional(),
      kind: EntityKind,
      name: Name,
      aliases: z.array(Name).default([]),
      parent: EntityId.nullable().default(null),
      zone: Zone.optional(),
      props: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z.object({ op: z.literal("move"), id: EntityId, to: EntityId, zone: Zone.optional() }).strict(),
  z
    .object({
      op: z.literal("author_update"),
      id: EntityId,
      name: Name.optional(),
      aliases: z.array(Name).optional(),
      props: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_character"),
      id: EntityId,
      description: Text.optional(),
      appearance: Text.optional(),
      traits: Text.optional(),
      goals: Text.optional(),
      backstory: Text.optional(),
      aliases: z.array(Name).optional(),
      /** Stats nobody has seen yet; existing values are never overwritten by this op. */
      add_stats: z
        .object({
          attributes: z.record(z.string(), Tier).optional(),
          skills: z.record(z.string(), Tier).optional(),
          abilities: z.record(z.string(), Tier).optional(),
        })
        .optional(),
      /** Engine only: a whole rated sheet from casting. */
      sheet: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z.object({ op: z.literal("group_count"), id: EntityId, delta: z.number().int() }).strict(),
  z
    .object({
      op: z.literal("split_member"),
      group: EntityId,
      id: EntityId.optional(),
      name: Name,
      zone: Zone.optional(),
      props: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z.object({ op: z.literal("practice"), character: EntityId, key: Name, value: z.number().min(0) }).strict(),
  z.object({ op: z.literal("remove_entity"), id: EntityId }).strict(),
  z.object({ op: z.literal("rename"), id: EntityId, name: Name }).strict(),
  z
    .object({
      op: z.literal("secret"),
      text: Text,
      kind: z.enum(SECRET_KINDS).default("twist"),
      subjects: z.array(EntityId).default([]),
      known_by: z.array(EntityId).default([]),
      urgency: z.enum(URGENCIES).default("dormant"),
    })
    .strict(),
  z.object({ op: z.literal("reveal"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("hint"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("secret_urgency"), id: z.string().min(1), to: z.enum(URGENCIES) }).strict(),
  z.object({ op: z.literal("set_zone"), id: EntityId, zone: Zone }).strict(),
  z.object({ op: z.literal("set_posture"), id: EntityId, posture: Name }).strict(),
  z.object({ op: z.literal("hold"), character: EntityId, item: EntityId, hand: Hand.optional() }).strict(),
  z
    .object({ op: z.literal("release"), character: EntityId, item: EntityId, drop: z.boolean().default(false) })
    .strict(),
  z.object({ op: z.literal("wear"), character: EntityId, item: EntityId, slot: Zone.optional() }).strict(),
  z.object({ op: z.literal("unwear"), character: EntityId, slot: Zone }).strict(),
  z.object({ op: z.literal("give"), from: EntityId, to: EntityId, item: EntityId }).strict(),
  z
    .object({
      op: z.literal("set_condition"),
      id: EntityId,
      add: z.array(Name).default([]),
      remove: z.array(Name).default([]),
    })
    .strict(),
  z
    .object({
      op: z.literal("relation"),
      id: EntityId,
      add: z.array(Relation).default([]),
      remove: z.array(Relation).default([]),
    })
    .strict(),
  z.object({ op: z.literal("emotion"), npc: EntityId, set: z.array(Name).max(8) }).strict(),
  z.object({ op: z.literal("thought"), npc: EntityId, key: z.string().regex(/^[a-z0-9_]{1,40}$/), text: Text }).strict(),
  z.object({ op: z.literal("forget_thought"), npc: EntityId, key: z.string().min(1) }).strict(),
  z.object({ op: z.literal("relationship_note"), npc: EntityId, target: EntityId, text: Text }).strict(),
  z.object({ op: z.literal("fact"), text: Text, subjects: z.array(EntityId).default([]) }).strict(),
  z.object({ op: z.literal("time_advance"), minutes: z.number().int().positive() }).strict(),
  z
    .object({ op: z.literal("resource_delta"), character: EntityId, resource: Name, delta: z.number() })
    .strict(),
  z
    .object({
      op: z.literal("progression"),
      character: EntityId,
      path: z.enum(["attributes", "skills", "abilities", "power_tier"]),
      key: Name.optional(),
      to: Tier,
    })
    .strict(),
]);
export type Op = z.infer<typeof Op>;
export type OpInput = z.input<typeof Op>;
export type OpName = Op["op"];

/** Ops only author mode may emit. */
export const AUTHOR_ONLY_OPS: ReadonlySet<OpName> = new Set(["author_update"]);

/** Ops the narrator may never emit: they come only from code-resolved outcomes. */
export const ENGINE_ONLY_OPS: ReadonlySet<OpName> = new Set(["resource_delta", "progression", "practice", "remove_entity", "secret", "hint", "secret_urgency"]);

export const OpSource = z.enum(["narrator", "engine", "author"]);
export type OpSource = z.infer<typeof OpSource>;
