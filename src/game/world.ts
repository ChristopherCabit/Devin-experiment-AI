import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { OpInput } from "../ops/schema.js";
import { clockMinutes, threads, worldEvents } from "../world/queries.js";
import type { WorldStore } from "../world/store.js";
import type { Entity, Thread, WorldEvent } from "../world/types.js";
import type { WorldSettings } from "./context.js";
import { scope, type Pace } from "./secrets.js";

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };
const CALM = new Set<Pace>(["quiet", "intimate"]);
const URGENCY_RANK = { urgent: 2, rising: 1, low: 0 } as const;
const H = 60;

const names = (store: WorldStore, ids: string[]) => ids.map((id) => store.getEntity(id)?.name ?? id).join(", ");
const hours = (m: number) => (Math.abs(m) < 48 * H ? `${Math.round(m / H)}h` : `${Math.round(m / (24 * H))}d`);

/** Overdue open threads become urgent. */
export function agingOps(store: WorldStore): OpInput[] {
  const now = clockMinutes(store);
  return threads(store)
    .filter((t) => t.status === "open" && t.deadline !== null && t.deadline <= now && t.urgency !== "urgent")
    .map((t) => ({ op: "thread_update", id: t.id, urgency: "urgent", note: "the deadline has passed" }) as OpInput);
}

/** Threads touching this scene, at most `threadsShown`. Calm moments only admit urgent ones; unrelated threads only intrude when influence is "pressing". */
export function selectThreads(store: WorldStore, playerId: string, pace: Pace, s: WorldSettings): Thread[] {
  if (!s.threads || s.threadsShown <= 0) return [];
  const { ids } = scope(store, playerId);
  const open = threads(store).filter((t) => t.status === "open" && t.known);
  const touches = (t: Thread) => t.participants.some((id) => ids.has(id)) || (t.place !== null && ids.has(t.place));
  let pool = open.filter((t) => touches(t) || (s.influence === "pressing" && t.urgency === "urgent"));
  if (CALM.has(pace)) pool = pool.filter((t) => t.urgency === "urgent" && touches(t));
  return pool.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || b.touched_turn - a.touched_turn).slice(0, s.threadsShown);
}

export function threadText(store: WorldStore, list: Thread[], s: WorldSettings): string {
  if (!list.length) return "";
  const now = clockMinutes(store);
  const lines = list.map((t) => {
    const due = t.deadline === null ? "" : t.deadline <= now ? ", overdue" : `, due in ${hours(t.deadline - now)}`;
    const who = t.participants.length ? ` Involves: ${names(store, t.participants)}.` : "";
    return `- [${t.id}] ${t.title} (${t.urgency}${due}): ${t.text}${who}${t.notes.length ? ` Latest: ${t.notes[t.notes.length - 1]}` : ""}`;
  });
  const how =
    s.influence === "pressing"
      ? "Urgent ones may intrude when it is plausible right now; others only if the moment leads there."
      : "Background only. Use one only if this moment naturally leads there (the player raises it, or someone present plausibly would). Ignoring all of them is normal.";
  return `## Open threads (${how} Never force them in.)\n${lines.join("\n")}`;
}

/** Recent off-screen experiences of the characters present, for colouring behaviour. */
export function lifeText(store: WorldStore, present: Entity[]): string {
  const now = clockMinutes(store);
  const lines: string[] = [];
  for (const c of present) {
    const life = Array.isArray(c.props.life) ? (c.props.life as { text: string; at: number }[]) : [];
    const recent = life.filter((l) => now - l.at <= 36 * H).slice(-2);
    if (recent.length) lines.push(`- ${c.name}: ${recent.map((l) => `${l.text} (${hours(now - l.at)} ago)`).join("; ")}`);
  }
  return lines.length
    ? `## Their lives off-screen (private to them. At most let it show in mood, fatigue or a small physical sign; they bring it up only if they would with this person. Never narrate it as backstory.)\n${lines.join("\n")}`
    : "";
}

/** Hours before news of an event reaches somewhere outside its origin, by reach and connectedness; null = never. */
const DELAY: Record<WorldSettings["connectedness"], Record<WorldEvent["reach"], number | null>> = {
  isolated: { local: null, regional: 24 * 7, world: null },
  regional: { local: null, regional: 24 * 2, world: 24 * 14 },
  global: { local: 24 * 3, regional: 12, world: 24 },
};

/** Whether news of an event has plausibly reached a given location by now. */
export function newsReached(store: WorldStore, e: WorldEvent, at: string | null, s: WorldSettings): boolean {
  const chain: string[] = [];
  for (let cur = at ? store.getEntity(at) : null; cur; cur = cur.parent_id ? store.getEntity(cur.parent_id) : null) chain.push(cur.id);
  if (e.origin && chain.includes(e.origin)) return true;
  if (!e.origin && e.reach === "world") return clockMinutes(store) - e.at >= (DELAY[s.connectedness].world ?? Infinity) * H;
  const d = DELAY[s.connectedness][e.reach];
  return d !== null && clockMinutes(store) - e.at >= d * H;
}

export function newsText(store: WorldStore, playerId: string, s: WorldSettings): string {
  if (!s.worldEvents) return "";
  const here = store.getEntity(playerId)?.parent_id ?? null;
  const now = clockMinutes(store);
  const known = worldEvents(store).filter((e) => now - e.at <= 24 * 30 * H && newsReached(store, e, here, s)).slice(-2);
  return known.length
    ? `## Wider world (news that has plausibly reached this place. People mention it only if it would come up naturally; most scenes it doesn't.)\n${known.map((e) => `- ${e.text} (${e.reach}, ${hours(now - e.at)} ago)`).join("\n")}`
    : "";
}

/** Whether an off-screen period is due. */
export function lifeDue(store: WorldStore, s: WorldSettings): boolean {
  if (!s.npcLives && !s.worldEvents) return false;
  const last = store.getMeta<number>("life_tick", -1);
  if (last < 0) {
    store.setMeta("life_tick", clockMinutes(store));
    return false;
  }
  return clockMinutes(store) - last >= s.lifeEveryHours * H;
}

/** Off-screen characters worth simulating: tied to open threads, recently in the story, or important world characters. */
export function trackedNpcs(store: WorldStore, playerId: string, recentText: string, s: WorldSettings): Entity[] {
  const here = store.getEntity(playerId)?.parent_id ?? null;
  const open = threads(store).filter((t) => t.status === "open");
  const scored = store
    .entitiesOfKind("character")
    .filter((c) => c.id !== playerId && c.parent_id !== here && !c.props.group && c.props.dead !== true)
    .map((c) => {
      let score = 0;
      if (open.some((t) => t.participants.includes(c.id))) score += 3;
      if ([c.name, ...c.aliases].some((n) => n.length > 2 && recentText.includes(n))) score += 2;
      if (c.created_turn <= 1) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, s.lifeTracked).map((x) => x.c);
}

const Period = z.object({
  npcs: z
    .array(
      z.object({
        id: z.string(),
        where: z.string().nullable().catch(null),
        mood: z.array(z.string().max(30)).max(3).nullable().catch(null),
        event: z.string().max(300).nullable().catch(null),
        thought: z.string().max(300).nullable().catch(null),
        opinion: z.object({ topic: z.string().min(1).max(80), view: z.string().min(1).max(200), why: z.string().min(1).max(200) }).nullable().catch(null),
      }),
    )
    .catch([]),
  world_event: z.object({ text: z.string().min(1).max(600), reach: z.enum(["local", "regional", "world"]).catch("local"), origin: z.string().nullable().catch(null) }).nullable().catch(null),
});

const PERIOD_SYSTEM = `You simulate the off-screen lives of characters in a text adventure while the protagonist is elsewhere. For each listed character, decide what they plausibly did over the period, given their personality, goals, relationships, open threads, the time of day and the news they could have heard.
Rules:
- Most periods are routine: work, meals, sleep, errands. Then "event" is null. Give at most 2 notable events across ALL characters, and only when it follows from who they are or an open thread; none is common.
- An event is something that happened TO or BY them (an argument, a bad sale, a letter, a drink too many), told plainly in one sentence. If it involves another listed character, write it the same way for both.
- They know only what they witnessed or were plausibly told. They cannot know what the protagonist did unless someone who saw it told them.
- "where": a room id from Rooms if they moved, else null. They can't reach a place farther than the period allows, and never the protagonist's room.
- "mood": 1-3 words if it changed, else null. "thought": a short private thought if something new is on their mind, else null.
- "opinion": usually null. Only when something from this period (news they heard, an event, a talk with someone) would change their mind about a person or topic: the topic, their new view, and why. Never without a reason from this period.
- "world_event": usually null. Only when asked for, something happening in the wider world fitting the setting's tone: "local" (this town), "regional" or "world" reach, with "origin" a place id or null.
Output ONLY JSON: {"npcs":[{"id":ID,"where":ID|null,"mood":[str]|null,"event":str|null,"thought":str|null,"opinion":{"topic":str,"view":str,"why":str}|null}],"world_event":{"text":str,"reach":str,"origin":ID|null}|null}`;

/** One batched call for the whole period. Returns ops for the next turn's engine batch. */
export async function simulatePeriod(
  store: WorldStore,
  llm: Llm,
  s: WorldSettings,
  playerId: string,
  recentText: string,
  rng: () => number,
): Promise<{ ops: OpInput[]; cost: number }> {
  const now = clockMinutes(store);
  const elapsedH = Math.max(1, (now - store.getMeta<number>("life_tick", 0)) / H);
  const npcs = s.npcLives ? trackedNpcs(store, playerId, recentText, s) : [];
  const wantEvent = s.worldEvents && rng() < Math.min(1, elapsedH / (Math.max(0.5, s.worldEventDays) * 24));
  const ops: OpInput[] = [{ op: "life_tick" }];
  if (!npcs.length && !wantEvent) return { ops, cost: 0 };
  const here = store.getEntity(playerId)?.parent_id ?? null;
  const rooms = store.entitiesOfKind("room").slice(0, 60);
  const card = (c: Entity) => {
    const { life, opinions, ...props } = c.props;
    const lastLife = Array.isArray(life) ? (life as { text: string }[]).slice(-1).map((l) => l.text) : [];
    const heard = worldEvents(store).filter((e) => newsReached(store, e, c.parent_id, s)).slice(-2).map((e) => e.text);
    return JSON.stringify({ id: c.id, name: c.name, at: c.parent_id, props: JSON.stringify(props).slice(0, 500), opinions: opinions ?? {}, recently: lastLife, heard });
  };
  const open = threads(store).filter((t) => t.status === "open").slice(-8).map((t) => `[${t.id}] ${t.title}: ${t.text} (involves ${names(store, t.participants) || "?"})`);
  const user = [
    `Setting: ${s.title}. ${s.premise}`.slice(0, 800),
    `Period: the last ${Math.round(elapsedH)} hours, ending at clock minute ${now} (${Math.floor((now % 1440) / 60)}:00).`,
    `Protagonist's room (off limits): ${here}`,
    `Rooms: ${rooms.map((r) => `${r.id} (${r.name}${r.parent_id ? ` in ${store.getEntity(r.parent_id)?.name ?? r.parent_id}` : ""})`).join("; ")}`,
    `Open threads:\n${open.join("\n") || "none"}`,
    `Characters:\n${npcs.map(card).join("\n") || "none"}`,
    wantEvent ? "Also invent one world_event." : "world_event must be null.",
  ].join("\n\n");
  const res = await llm.chat({ model: s.parserModel, json: true, maxTokens: 300 + 120 * npcs.length, temperature: 0.8, reasoning: "off", messages: [{ role: "system", content: PERIOD_SYSTEM }, { role: "user", content: user }] });
  let parsed: z.infer<typeof Period>;
  try {
    parsed = Period.parse(JSON.parse(/\{[\s\S]*\}/.exec(res.text)?.[0] ?? "{}"));
  } catch {
    return { ops, cost: res.costUsd };
  }
  const ids = new Set(npcs.map((c) => c.id));
  let events = 0;
  let changed = 0;
  for (const n of parsed.npcs) {
    if (!ids.has(n.id)) continue;
    const c = store.getEntity(n.id);
    if (!c) continue;
    if (n.where && n.where !== here && n.where !== c.parent_id && store.getEntity(n.where)?.kind === "room") ops.push({ op: "move", id: n.id, to: n.where });
    if (n.mood?.length) ops.push({ op: "emotion", npc: n.id, set: n.mood });
    if (n.event && events < 2) {
      events++;
      ops.push({ op: "life_event", npc: n.id, text: n.event.slice(0, 300) });
    }
    if (n.thought) ops.push({ op: "thought", npc: n.id, key: "offscreen", text: n.thought.slice(0, 300) });
    if (n.opinion && changed++ < 2) ops.push({ op: "opinion", id: n.id, ...n.opinion });
  }
  const w = parsed.world_event;
  if (wantEvent && w) ops.push({ op: "world_event", text: w.text, reach: w.reach, origin: w.origin && store.getEntity(w.origin) ? w.origin : null });
  return { ops, cost: res.costUsd };
}
