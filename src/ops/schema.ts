import { z } from "zod";
import { EntityId, EntityKind, Hand, Relation, Tier } from "../world/types.js";

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

/** Ops the narrator may never emit: they come only from code-resolved outcomes. */
export const ENGINE_ONLY_OPS: ReadonlySet<OpName> = new Set(["resource_delta", "progression"]);

export const OpSource = z.enum(["narrator", "engine", "author"]);
export type OpSource = z.infer<typeof OpSource>;
