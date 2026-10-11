import { TurnLog } from "../src/engine/turns.js";
import { clockMinutes } from "../src/world/queries.js";
import { WorldStore } from "../src/world/store.js";

export const PLAYER = "character:you";

export function makeWorld() {
  const store = new WorldStore();
  const log = new TurnLog(store);
  const ops = [
    { op: "create_entity", id: "region:town", kind: "region", name: "Town" },
    { op: "create_entity", id: "place:house", kind: "place", name: "House", parent: "region:town" },
    {
      op: "create_entity",
      id: "room:bedroom",
      kind: "room",
      name: "Bedroom",
      parent: "place:house",
      props: { zones: ["door", "bed", "window"], adjacent: [["bed", "window"]] },
    },
    { op: "create_entity", id: "room:kitchen", kind: "room", name: "Kitchen", parent: "place:house" },
    { op: "create_entity", id: "place:bakery", kind: "place", name: "Bakery", parent: "region:town" },
    { op: "create_entity", id: "room:shop", kind: "room", name: "Shop", parent: "place:bakery" },
    {
      op: "create_entity",
      id: PLAYER,
      kind: "character",
      name: "You",
      parent: "room:bedroom",
      zone: "door",
      props: { is_player: true, age: 25, sheet: { skills: { swordsmanship: 3 }, resources: { hp: { value: 10, max: 10 } } } },
    },
    { op: "create_entity", id: "character:mara", kind: "character", name: "Mara", parent: "room:bedroom", zone: "bed", props: { age: 27 } },
    { op: "create_entity", id: "item:coat", kind: "item", name: "coat", parent: "room:bedroom", zone: "window", props: { slot: "torso" } },
    { op: "create_entity", id: "container:chest", kind: "container", name: "chest", parent: "room:bedroom", zone: "bed", props: { closed: true } },
    { op: "create_entity", id: "item:bed", kind: "item", name: "bed", parent: "room:bedroom", zone: "bed", props: { fixed: true } },
    { op: "create_entity", id: "item:ring", kind: "item", name: "ring", parent: "container:chest" },
    { op: "create_entity", id: "item:keys", kind: "item", name: "keys", aliases: ["key ring"], parent: "character:mara" },
    { op: "create_entity", id: "item:knife", kind: "item", name: "kitchen knife", aliases: ["knife"], parent: "room:kitchen" },
    { op: "create_entity", id: "item:apple", kind: "item", name: "apple", parent: PLAYER },
  ];
  const { results } = log.commit({ kind: "author", input: "setup", ops, source: "author" });
  const bad = results.filter((r) => !r.ok);
  if (bad.length) throw new Error(`fixture failed: ${JSON.stringify(bad)}`);
  return { store, log };
}

export function snapshot(store: WorldStore): string {
  return JSON.stringify({ entities: store.allEntities(), facts: store.facts(), clock: clockMinutes(store) });
}
