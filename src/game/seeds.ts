import type { OpInput } from "../ops/schema.js";
import type { WorldSettings } from "./context.js";

export const PLAYER_ID = "character:you";

export interface Seed {
  settings: Partial<WorldSettings>;
  ops: OpInput[];
  opening: string;
}

export const STARTER: Seed = {
  settings: {
    title: "The Lantern Inn",
    premise:
      "A rain-soaked frontier town at the edge of old forest. Coin is scarce, the local lord is absent, and mercenaries drift through. You arrived last night with little more than a sword and a debt you'd rather not discuss.",
  },
  opening:
    "Rain drums on the shutters of the Lantern Inn. The common room smells of woodsmoke and wet wool. Behind the bar, Mara wipes the same mug for the third time, watching you over its rim. In the corner, a scarred mercenary nurses a drink and doesn't bother hiding that he's sizing you up.",
  ops: [
    { op: "time_advance", minutes: 19 * 60 },
    { op: "create_entity", id: "region:marrow", kind: "region", name: "Marrowfield" },
    { op: "create_entity", id: "place:inn", kind: "place", name: "Lantern Inn", parent: "region:marrow" },
    {
      op: "create_entity",
      id: "room:common",
      kind: "room",
      name: "Common Room",
      aliases: ["downstairs", "taproom"],
      parent: "place:inn",
      props: { zones: ["door", "bar", "hearth", "corner table", "stairs"], adjacent: [["bar", "hearth"], ["hearth", "corner table"], ["bar", "stairs"]], description: "Low beams, a crackling hearth, a scarred oak bar." },
    },
    { op: "create_entity", id: "room:upstairs", kind: "room", name: "Your Room", aliases: ["upstairs", "my room", "rented room"], parent: "place:inn", props: { zones: ["door", "bed", "window"], description: "A narrow rented room under the eaves." } },
    { op: "create_entity", id: "place:street", kind: "place", name: "Muddy Street", parent: "region:marrow" },
    { op: "create_entity", id: "room:street", kind: "room", name: "Street", parent: "place:street" },
    {
      op: "create_entity",
      id: PLAYER_ID,
      kind: "character",
      name: "You",
      parent: "room:common",
      zone: "hearth",
      props: {
        is_player: true,
        age: 25,
        description: "A travel-worn sellsword.",
        sheet: {
          power_tier: 3,
          attributes: { strength: 4, agility: 4, wits: 3, charm: 3 },
          skills: { swordsmanship: 4, stealth: 2, persuasion: 3 },
          resources: { hp: { value: 10, max: 10 }, coin: { value: 6, min: 0, max: 100000 } },
        },
      },
    },
    { op: "create_entity", id: "item:sword", kind: "item", name: "longsword", aliases: ["sword"], parent: PLAYER_ID, props: { slot: "belt" } },
    { op: "create_entity", id: "item:cloak", kind: "item", name: "wet cloak", aliases: ["cloak"], parent: PLAYER_ID, props: { slot: "back" } },
    { op: "create_entity", id: "item:key", kind: "item", name: "room key", aliases: ["key"], parent: PLAYER_ID },
    {
      op: "create_entity",
      id: "character:mara",
      kind: "character",
      name: "Mara",
      parent: "room:common",
      zone: "bar",
      props: {
        age: 29,
        description: "The innkeeper. Sharp-tongued, freckled, sleeves rolled up, a cudgel under the bar.",
        traits: "Proud, prickly, secretly lonely; brusque toward people she likes; fiercely protective of the inn.",
        expression: "Shows interest through teasing and insults; deflects affection with work; frustration comes out physically.",
        goals: "Keep the inn afloat; pay off what she owes Rook's employer.",
        secrets: "She is three months behind on a debt to the Ashen Company.",
        volatility: "medium",
        sheet: { power_tier: 2, skills: { brawling: 3, haggling: 5 } },
        mind: { emotions: ["curious", "irritated"], thoughts: { newcomer: "This one looks like trouble. Trouble pays, sometimes." } },
      },
    },
    {
      op: "create_entity",
      id: "character:rook",
      kind: "character",
      name: "Rook",
      parent: "room:common",
      zone: "corner table",
      props: {
        age: 41,
        description: "A scarred mercenary in a patched Ashen Company coat.",
        traits: "Patient, greedy, contemptuous of weakness, honours deals to the letter.",
        goals: "Collect Mara's debt by any means; recruit or remove competition.",
        volatility: "low until crossed",
        sheet: { power_tier: 5, skills: { swordsmanship: 6, intimidation: 6 }, resources: { hp: { value: 14, max: 14 } } },
        mind: { emotions: ["bored", "appraising"], thoughts: { you: "New sword in town. Useful, or in the way." } },
      },
    },
  ],
};
