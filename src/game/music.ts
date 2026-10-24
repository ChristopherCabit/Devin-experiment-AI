import { z } from "zod";
import type { ChatRequest, ChatResult } from "../llm/client.js";
import type { Files } from "../platform/files.js";

/**
 * Background music. A cheap model tags the passage's atmosphere from a closed vocabulary, and code builds the
 * music prompt from those tags plus the world's music style. No story text, names or events reach the music model.
 */
export const MOODS = ["calm", "warm", "tender", "melancholy", "somber", "tense", "ominous", "eerie", "mysterious", "playful", "romantic", "triumphant", "energetic", "frantic"] as const;
export const ENERGIES = ["low", "medium", "high"] as const;
export const Cue = z.object({ mood: z.enum(MOODS), energy: z.enum(ENERGIES) });
export type Cue = z.infer<typeof Cue>;

const MOOD_WORDS: Record<Cue["mood"], string> = {
  calm: "calm, peaceful",
  warm: "warm, comforting",
  tender: "tender, intimate",
  melancholy: "melancholic, wistful",
  somber: "somber, heavy",
  tense: "tense, suspenseful",
  ominous: "ominous, dark",
  eerie: "eerie, unsettling",
  mysterious: "mysterious, curious",
  playful: "playful, light",
  romantic: "romantic, sensual",
  triumphant: "triumphant, uplifting",
  energetic: "energetic, driving",
  frantic: "frantic, urgent",
};
const TEMPO: Record<Cue["energy"], string> = {
  low: "slow tempo around 70 bpm, sparse",
  medium: "moderate tempo around 95 bpm",
  high: "fast tempo around 130 bpm, dense",
};

/** The creator's style line, reduced to plain words. */
export const cleanStyle = (s: string) =>
  s
    .replace(/[^\p{L}\p{N} ,&'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

export function musicPrompt(cue: Cue, style: string): string {
  return [
    "Instrumental only: no vocals, no singing, no lyrics, no spoken words.",
    `${cleanStyle(style) || "Cinematic underscore"}.`,
    `Mood: ${MOOD_WORDS[cue.mood]}.`,
    `${TEMPO[cue.energy]}.`,
    "Unobtrusive background music that loops smoothly, about 50 seconds long.",
  ].join(" ");
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export const cueKey = (cue: Cue, style: string, model = "") => `${hash(`${cleanStyle(style).toLowerCase()}|${model}`)}-${cue.mood}-${cue.energy}`;

type Llm = { chat(req: ChatRequest): Promise<ChatResult> };

const TAG_PROMPT = `Choose background music for the atmosphere of a story passage. Output ONLY JSON: {"mood": ${MOODS.map((m) => `"${m}"`).join("|")}, "energy": "low"|"medium"|"high"}. Judge the emotional atmosphere, not the events.`;

export async function tagScene(llm: Llm, model: string, passage: string): Promise<Cue | null> {
  try {
    const r = await llm.chat({
      model,
      messages: [
        { role: "system", content: TAG_PROMPT },
        { role: "user", content: passage.slice(-1500) },
      ],
      maxTokens: 40,
      temperature: 0,
    });
    const json = r.text.match(/\{[\s\S]*\}/)?.[0];
    const cue = json ? Cue.safeParse(JSON.parse(json)) : null;
    return cue?.success ? cue.data : null;
  } catch {
    return null;
  }
}

export interface Track {
  key: string;
  audio: Uint8Array;
}

export interface MusicSource {
  style: string;
  model?: string;
  tag(passage: string): Promise<Cue | null>;
  generate(prompt: string): Promise<{ audio: Uint8Array; text: string; costUsd?: number }>;
}

const TITLE_WORDS: Record<Cue["mood"], string> = {
  calm: "Still Water",
  warm: "Hearthlight",
  tender: "Quiet Hands",
  melancholy: "Grey Rain",
  somber: "Long Shadows",
  tense: "Held Breath",
  ominous: "Gathering Dark",
  eerie: "Hollow Halls",
  mysterious: "Hidden Paths",
  playful: "Bright Steps",
  romantic: "Candle Glow",
  triumphant: "High Banners",
  energetic: "Open Road",
  frantic: "Breakneck",
};
const FORMS: Record<Cue["energy"], string> = { low: "Nocturne", medium: "Air", high: "Gallop" };
export const trackTitle = (cue: Cue) => `${TITLE_WORDS[cue.mood]} ${FORMS[cue.energy]}`;

export const TrackInfo = z.object({
  key: z.string(),
  title: z.string(),
  mood: z.enum(MOODS).nullable(),
  energy: z.enum(ENERGIES).nullable(),
  style: z.string().nullable(),
  model: z.string().nullable(),
  /** Exactly what was sent to the music model. */
  prompt: z.string().nullable(),
  costUsd: z.number().nullable(),
  bytes: z.number().nullable(),
  created: z.number().nullable(),
});
export type TrackInfo = z.infer<typeof TrackInfo>;

const INDEX = "music/index.json";
const KEY_RE = new RegExp(`-(${MOODS.join("|")})-(${ENERGIES.join("|")})$`);

/** The tracks saved on this device, with what is known about each. Shared by every save. */
export class MusicBank {
  constructor(private readonly files: Files) {}

  private async index(): Promise<Record<string, TrackInfo>> {
    const raw = await this.files.read(INDEX);
    if (!raw) return {};
    try {
      return z.record(z.string(), TrackInfo).catch({}).parse(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return {};
    }
  }

  private async save(idx: Record<string, TrackInfo>) {
    await this.files.mkdir("music");
    await this.files.write(INDEX, new TextEncoder().encode(JSON.stringify(idx)));
  }

  async record(info: TrackInfo) {
    const idx = await this.index();
    idx[info.key] = info;
    await this.save(idx);
  }

  async list(): Promise<TrackInfo[]> {
    const idx = await this.index();
    const keys = (await this.files.list("music")).filter((n) => n.endsWith(".mp3")).map((n) => n.slice(0, -4));
    return keys.map((k) => idx[k] ?? untracked(k)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.title.localeCompare(b.title));
  }

  audio(key: string): Promise<Uint8Array | null> {
    return /^[\w-]+$/.test(key) ? this.files.read(`music/${key}.mp3`) : Promise.resolve(null);
  }

  async remove(key: string) {
    if (!/^[\w-]+$/.test(key)) throw new Error("bad track key");
    await this.files.remove(`music/${key}.mp3`);
    const idx = await this.index();
    if (key in idx) await this.save(Object.fromEntries(Object.entries(idx).filter(([k]) => k !== key)));
  }
}

/** A track saved before the bank kept details: mood and energy are still in its key. */
function untracked(key: string): TrackInfo {
  const m = KEY_RE.exec(key);
  const cue = m ? Cue.parse({ mood: m[1], energy: m[2] }) : null;
  return { key, title: cue ? trackTitle(cue) : key, mood: cue?.mood ?? null, energy: cue?.energy ?? null, style: null, model: null, prompt: null, costUsd: null, bytes: null, created: null };
}

/** Decides when the music changes, and keeps generated tracks on the device so each style/mood/energy is paid for once. */
export class MusicDirector {
  private current: string | null = null;
  private pending: string | null = null;
  private readonly busy = new Set<string>();
  private readonly failed = new Set<string>();

  private readonly bank: MusicBank;

  constructor(private readonly files: Files) {
    this.bank = new MusicBank(files);
  }

  /** Stop treating a deleted track as playing, so the mood can make a new one. */
  forget(key: string) {
    if (this.current === key) this.current = null;
    if (this.pending === key) this.pending = null;
  }

  /** A new track to play, or null to keep the current one. Without `force`, a calmer change must hold for two passages. */
  async next(passage: string, src: MusicSource, force = false): Promise<Track | null> {
    const cue = await src.tag(passage);
    if (!cue) return null;
    const key = cueKey(cue, src.style, src.model);
    if (key === this.current && !force) {
      this.pending = null;
      return null;
    }
    if (!force && this.current !== null && cue.energy !== "high" && this.pending !== key) {
      this.pending = key;
      return null;
    }
    this.pending = null;
    const path = `music/${key}.mp3`;
    let audio = await this.files.read(path);
    if (!audio) {
      if (this.busy.has(key) || this.failed.has(key)) return null;
      this.busy.add(key);
      try {
        const prompt = musicPrompt(cue, src.style);
        const r = await src.generate(prompt);
        if (/[a-z]{3,}/i.test(r.text.replace(/<\/?instrumental>/gi, ""))) {
          this.failed.add(key);
          return null;
        }
        audio = r.audio;
        await this.files.mkdir("music");
        await this.files.write(path, audio);
        const info = { key, title: trackTitle(cue), mood: cue.mood, energy: cue.energy, style: cleanStyle(src.style) || null, model: src.model ?? null, prompt, costUsd: r.costUsd ?? null, bytes: audio.length, created: Date.now() };
        await this.bank.record(info).catch(() => undefined);
      } finally {
        this.busy.delete(key);
      }
    }
    this.current = key;
    return { key, audio };
  }
}
