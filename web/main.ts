import { Game, type GameState } from "../src/app/game.js";
import { initSqlite } from "../src/db/sqlite.js";
import type { PlayKind, TurnOutput } from "../src/game/pipeline.js";
import { ATTRIBUTES, playerCap, pointBudget, pointCost } from "../src/game/rules.js";
import type { WorldDraft } from "../src/game/setup.js";
import type { Entity } from "../src/world/types.js";
import { detectPlatform } from "./platform.js";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
let game: Game;

function clockText(m: number) {
  const d = Math.floor(m / 1440) + 1, h = String(Math.floor((m % 1440) / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0");
  return `Day ${d} ${h}:${mm}`;
}

function render(s: GameState) {
  $("title").textContent = s.settings.title;
  const hp = s.sheet?.resources?.hp as { value: number; max?: number } | undefined;
  $("status").textContent = [s.location, s.zone, clockText(s.clock), hp ? `HP ${hp.value}/${hp.max ?? "?"}` : null, ...s.conditions].filter(Boolean).join(" · ");
  const story = $("story");
  story.replaceChildren();
  for (const t of s.turns) {
    if (t.input && t.kind !== "continue" && t.kind !== "system") {
      const p = document.createElement("p");
      p.className = "you";
      p.textContent = t.kind === "say" ? `You say, "${t.input}"` : t.kind === "story" ? t.input : `> ${t.input}`;
      story.append(p);
    }
    if (t.output) {
      const p = document.createElement("p");
      p.textContent = t.output;
      story.append(p);
    }
  }
  story.scrollTop = story.scrollHeight;
  $("spend").textContent = `Spend this month: $${s.spend.spent.toFixed(3)} of $${s.spend.cap}` + (s.spend.warn ? " (near cap)" : "");
  const sh = s.sheet;
  if (sh) {
    const fmt = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
    $("sheet").textContent = `Sheet: power ${sh.power_tier}; ${fmt(sh.attributes)}; ${fmt(sh.skills)}`;
  }
  if (!s.hasKey) $("interpreted").textContent = "Add your OpenRouter API key in World → App settings to play.";
}

function busy(on: boolean) {
  for (const id of ["btn-send", "btn-undo", "btn-retry"]) $<HTMLButtonElement>(id).disabled = on;
}

function showTurn(out: TurnOutput & { state: GameState }) {
  render(out.state);
  loadEntities();
  $("interpreted").textContent = [out.interpreted ? `Interpreted as: ${out.interpreted}` : "", out.rejected.some((r) => !/engine|sheets are set/.test(r)) ? `Engine rejected: ${out.rejected.filter((r) => !/engine|sheets are set/.test(r)).join("; ")}` : ""]
    .filter(Boolean)
    .join(" · ");
}

$("turn-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const kind = (document.querySelector('input[name="kind"]:checked') as HTMLInputElement).value as PlayKind;
  const input = $("input").value.trim();
  if (!input && kind !== "continue") return;
  busy(true);
  const pending = document.createElement("p");
  pending.className = "pending";
  pending.textContent = "…";
  $("story").append(pending);
  $("story").scrollTop = $("story").scrollHeight;
  try {
    const out = await game.turn(kind, input, (t) => {
      pending.textContent = t || "…";
      $("story").scrollTop = $("story").scrollHeight;
    });
    $("input").value = "";
    showTurn(out);
  } catch (e) {
    pending.remove();
    $("interpreted").textContent = errText(e);
  }
  busy(false);
};
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
    e.preventDefault();
    $<HTMLFormElement>("turn-form").requestSubmit();
  }
});
$("btn-undo").onclick = async () => {
  busy(true);
  try {
    render(await game.undo());
    loadEntities();
    $("interpreted").textContent = "";
  } catch (e) {
    $("interpreted").textContent = errText(e);
  }
  busy(false);
};
$("btn-retry").onclick = async () => {
  busy(true);
  try {
    showTurn(await game.retry());
  } catch (e) {
    $("interpreted").textContent = errText(e);
  }
  busy(false);
};

// ---------- tabs ----------
function showTab(tab: string) {
  for (const x of document.querySelectorAll<HTMLButtonElement>("nav button")) x.classList.toggle("active", x.dataset.tab === tab);
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.hidden = t.id !== `tab-${tab}`;
  if (tab === "cast") loadEntities();
  if (tab === "world") {
    loadSettings();
    $<HTMLInputElement>("s-length-range").value = $<HTMLInputElement>("s-length").value;
  }
  if (tab === "new") updatePoints();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.onclick = () => showTab(b.dataset.tab ?? "play");

// ---------- author mode ----------
let entities: Entity[] = [];
function loadEntities(selectId?: string) {
  entities = game.entities();
  const sel = $<HTMLSelectElement>("entity-select");
  const keep = selectId || sel.value;
  sel.replaceChildren(...entities.filter((e) => e.kind !== "region").map((e) => new Option(`${e.name}${e.kind === "character" ? ` — ${entities.find((x) => x.id === e.parent_id)?.name ?? "nowhere"}` : ""} (${e.id})`, e.id)));
  if (keep) sel.value = keep;
  showEntity();
  renderSecrets();
  renderJournal();
}
function showEntity() {
  const e = entities.find((x) => x.id === $<HTMLSelectElement>("entity-select").value);
  if (!e) return;
  $("entity-name").value = e.name;
  $("entity-aliases").value = e.aliases.join(", ");
  $<HTMLTextAreaElement>("entity-props").value = JSON.stringify(e.props, null, 2);
}
$("entity-select").onchange = showEntity;
function renderSecrets() {
  const all = game.secrets();
  const spoil = $("show-spoilers").checked;
  const box = $("secrets-list");
  box.replaceChildren();
  const shown = spoil ? all : all.filter((s) => s.revealed);
  for (const s of shown) {
    const p = document.createElement("p");
    const about = s.subjects.map((id) => entities.find((e) => e.id === id)?.name ?? id).join(", ") || "the world";
    p.textContent = `${s.revealed ? "✓" : "?"} [${s.kind}${s.urgency !== "dormant" ? `, ${s.urgency}` : ""}] ${about}: ${s.text}`;
    box.append(p);
  }
  const hidden = all.length - shown.length;
  if (hidden) box.append(`${hidden} hidden secret${hidden === 1 ? "" : "s"}.`);
  if (!all.length) box.textContent = "None yet.";
}
function renderJournal() {
  const spoil = $("show-spoilers").checked;
  const box = $("journal-list");
  box.replaceChildren();
  const name = (id: string) => entities.find((e) => e.id === id)?.name ?? id;
  const list = game.threads().filter((t) => spoil || t.known);
  for (const t of [...list].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || b.touched_turn - a.touched_turn)) {
    const p = document.createElement("p");
    const mark = t.status === "open" ? (t.urgency === "urgent" ? "!" : "•") : t.status === "resolved" ? "✓" : "✗";
    const who = t.participants.length ? ` (${t.participants.map(name).join(", ")})` : "";
    p.textContent = `${mark} ${t.title}${who}: ${t.text}${t.notes.length ? ` — ${t.notes[t.notes.length - 1]}` : ""}`;
    box.append(p);
  }
  if (spoil) for (const e of game.worldEvents()) box.append(Object.assign(document.createElement("p"), { textContent: `World [${e.reach}] ${e.text}` }));
  if (!box.childNodes.length) box.textContent = "No open threads yet.";
}
$("show-spoilers").onchange = () => {
  renderSecrets();
  renderJournal();
};
$("btn-entity-save").onclick = async () => {
  try {
    const props = JSON.parse($<HTMLTextAreaElement>("entity-props").value);
    const aliases = $("entity-aliases").value.split(",").map((s) => s.trim()).filter(Boolean);
    const id = $<HTMLSelectElement>("entity-select").value;
    await game.updateEntity(id, { name: $("entity-name").value, aliases, props });
    $("cast-msg").textContent = "Saved.";
    loadEntities(id);
  } catch (e) {
    $("cast-msg").textContent = errText(e);
  }
};
$("btn-entity-add").onclick = async () => {
  try {
    const kind = $<HTMLSelectElement>("new-kind").value;
    const body: Record<string, unknown> = { kind, name: $("new-name").value, parent: $("new-parent").value || undefined };
    if (kind === "character") body.props = { age: 25 };
    const e = await game.createEntity(body);
    $("cast-msg").textContent = `Created ${e?.id}.`;
    loadEntities(e?.id);
  } catch (e) {
    $("cast-msg").textContent = errText(e);
  }
};

// ---------- world + app settings ----------
const SETTINGS = ["title", "premise", "style", "intensity", "limits", "deathPolicy", "powerCeiling", "thoughtsPerTurn", "length", "asides", "unboundedPower", "narratorModel", "parserModel", "narratorReasoning", "contextTokens", "threads", "threadsShown", "influence", "npcLives", "lifeEveryHours", "lifeTracked", "worldEvents", "worldEventDays", "connectedness"] as const;
const BOOLS = new Set<string>(["unboundedPower", "asides", "threads", "npcLives", "worldEvents"]);
const NUMERIC = new Set<string>(["thoughtsPerTurn", "contextTokens", "powerCeiling", "length", "threadsShown", "lifeEveryHours", "lifeTracked", "worldEventDays"]);
const say = (m: string) => ($("world-msg").textContent = m);
function loadSettings() {
  const s = game.settings() as unknown as Record<string, unknown>;
  for (const k of SETTINGS) {
    if (BOOLS.has(k)) $(`s-${k}`).checked = Boolean(s[k]);
    else $(`s-${k}`).value = String(s[k]);
  }
  progressionTo("s-prog", game.settings().progression);
  const c = game.config();
  $("cfg-key").value = "";
  $("cfg-key").placeholder = c.hasKey ? "Key saved on this device (enter a new one to replace)" : "sk-or-…";
  $("cfg-cap").value = String(c.capUsd);
  loadSaves();
}
$("btn-settings-save").onclick = async () => {
  const body: Record<string, unknown> = {};
  for (const k of SETTINGS) body[k] = BOOLS.has(k) ? $(`s-${k}`).checked : NUMERIC.has(k) ? Number($(`s-${k}`).value) : $(`s-${k}`).value;
  body.progression = progressionFrom("s-prog");
  if (body.unboundedPower && !game.settings().unboundedPower && !confirm("Turn on unbounded power? Your character's stats will no longer be capped.")) return;
  try {
    await game.updateSettings(body);
    say("Saved.");
    render(game.state());
  } catch (e) {
    say(errText(e));
  }
};
$("btn-cfg-save").onclick = async () => {
  try {
    const key = $("cfg-key").value.trim();
    await game.setConfig({ ...(key ? { apiKey: key } : {}), capUsd: Number($("cfg-cap").value) });
    loadSettings();
    render(game.state());
    say("App settings saved.");
  } catch (e) {
    say(errText(e));
  }
};
$("btn-cfg-clear").onclick = async () => {
  if (!confirm("Remove the API key from this device?")) return;
  await game.setConfig({ apiKey: null });
  loadSettings();
  say("Key removed.");
};

// ---------- saves ----------
const platform = await detectPlatform();
const safeName = (s: string) => s.replace(/[^\w -]+/g, "_");
function loadSaves() {
  const box = $("saves");
  box.textContent = "";
  for (const s of game.listSaves()) {
    const row = document.createElement("div");
    row.className = s.active ? "save active" : "save";
    const title = document.createElement("div");
    title.textContent = s.active ? `${s.name} (current)` : s.name;
    const btns = document.createElement("div");
    btns.className = "row";
    const add = (label: string, fn: () => Promise<unknown>, cls?: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => fn().then(loadSaves).catch((e) => say(errText(e)));
      btns.append(b);
    };
    if (!s.active)
      add("Load", async () => {
        render(await game.loadSave(s.id));
        loadSettings();
        say(`Loaded ${s.name}.`);
      });
    add("Rename", async () => {
      const n = prompt("New name", s.name);
      if (n) await game.renameSave(s.id, n);
    });
    add("Export", async () => {
      const { name, data } = await game.exportSave(s.id);
      if (await platform.exportFile(`${safeName(name)}.db`, data)) say("Exported.");
    });
    if (!s.active)
      add(
        "Delete",
        async () => {
          if (confirm(`Delete "${s.name}"? (It is moved to the app's deleted folder, not erased.)`)) await game.deleteSave(s.id);
        },
        "danger",
      );
    row.append(title, btns);
    box.append(row);
  }
}
$("btn-save-new").onclick = () => showTab("new");

// ---------- new adventure ----------
let draft: WorldDraft | null = null;
const nsay = (m: string) => ($("n-msg").textContent = m);
const parseStats = (t: string): Record<string, number> =>
  Object.fromEntries(
    t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
      const m = /^(.*?)\s+(\d+)$/.exec(x);
      return m ? [(m[1] ?? x).toLowerCase(), Number(m[2])] : [x.toLowerCase(), 1];
    }),
  );
const fmtStats = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
const statsMode = () => (document.querySelector('input[name="statsMode"]:checked') as HTMLInputElement).value;
function progressionFrom(pre: string) {
  const realms = $<HTMLTextAreaElement>(`${pre}-realms`).value.split("\n").map((x) => x.trim()).filter(Boolean);
  return {
    practice: $(`${pre}-practice`).checked,
    mentors: $(`${pre}-mentors`).checked,
    cultivation: realms.length >= 2 ? { realms, resource: $(`${pre}-resource`).value.trim() || null } : null,
  };
}
function progressionTo(pre: string, p: ReturnType<typeof progressionFrom>) {
  $(`${pre}-practice`).checked = p.practice;
  $(`${pre}-mentors`).checked = p.mentors;
  $<HTMLTextAreaElement>(`${pre}-realms`).value = p.cultivation?.realms.join("\n") ?? "";
  $(`${pre}-resource`).value = p.cultivation?.resource ?? "";
}
function brief() {
  return {
    progression: progressionFrom("n-prog"),
    title: $("n-title").value.trim() || "Untitled",
    premise: $<HTMLTextAreaElement>("n-premise").value,
    situation: $<HTMLTextAreaElement>("n-situation").value,
    intensity: $("n-intensity").value,
    limits: $("n-limits").value,
    deathPolicy: $("n-deathPolicy").value,
    powerCeiling: Math.min(10, Math.max(1, Number($("n-power").value) || 6)),
    unboundedPower: $("n-unbounded").checked,
  };
}
function playerStats() {
  return {
    attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a, Number($(`n-a-${a}`).value) || 0])),
    skills: parseStats($("n-skills").value),
    abilities: parseStats($("n-abilities").value),
  };
}
function updatePoints() {
  const b = brief(), st = playerStats(), cost = pointCost(st), budget = pointBudget(b.powerCeiling);
  const free = statsMode() === "freeform" || b.unboundedPower;
  $("n-points").textContent = `Points: ${cost}${free ? "" : ` of ${budget}`} · max ${playerCap(b)} per stat${b.unboundedPower ? " (unbounded)" : ""}`;
  $("n-points").classList.toggle("bad", !free && cost > budget);
}
$("tab-new").addEventListener("input", updatePoints);
$("n-template").onchange = () => ($("n-custom").hidden = $<HTMLSelectElement>("n-template").value === "starter");
$("n-unbounded").onchange = () => {
  if ($("n-unbounded").checked && !confirm("Unbounded power removes the stat cap and point budget for your character. Turn it on?")) $("n-unbounded").checked = false;
  updatePoints();
};
function showDraft(d: WorldDraft) {
  draft = d;
  $("n-draft").hidden = false;
  $<HTMLTextAreaElement>("n-opening").value = d.opening;
  const places = [`${d.start.place} / ${d.start.room} (start)`, ...d.places.map((p) => `${p.name}${p.rooms.length ? ` (${p.rooms.map((r) => r.name).join(", ")})` : ""}`)];
  $("n-places").textContent = `Locations: ${places.join("; ")}` + (d.secrets.length ? ` · ${d.secrets.length} secrets generated (hidden; see Edit → Show spoilers after starting)` : "");
  if (d.cultivation && !$<HTMLTextAreaElement>("n-prog-realms").value.trim()) progressionTo("n-prog", { ...progressionFrom("n-prog"), cultivation: d.cultivation });
  const list = $("n-npc-list");
  list.replaceChildren();
  if (!d.npcs.length) list.textContent = "No NPCs: you start alone.";
  d.npcs.forEach((n, i) => {
    const row = document.createElement("label");
    row.className = "npc";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.i = String(i);
    const t = document.createElement("span");
    const stats = fmtStats({ power: n.sheet.power_tier, ...n.sheet.skills });
    t.textContent = `${n.name}${n.count ? ` ×${n.count}` : ""}${n.age ? `, ${n.age}` : ""} — ${n.description} [${stats}]`;
    row.append(cb, t);
    list.append(row);
  });
}
async function draftWorld(mode: "generate" | "blank") {
  nsay(mode === "generate" ? "Generating…" : "");
  try {
    showDraft(await game.draftWorld({ brief: brief(), mode, npcs: $("n-npcs").checked, place: $("n-place").value.trim() || undefined, room: $("n-room").value.trim() || undefined }));
    nsay(mode === "generate" ? "Edit the opening or untick NPCs, then Start. Everything can be edited later in the Edit tab." : "");
  } catch (e) {
    nsay(errText(e));
  }
}
$("btn-n-generate").onclick = () => draftWorld("generate");
$("btn-n-blank").onclick = () => draftWorld("blank");
$("btn-n-propose").onclick = async () => {
  const description = $<HTMLTextAreaElement>("n-desc").value.trim();
  if (!description) return nsay("Write a description first.");
  nsay("Proposing…");
  try {
    const st = await game.proposeStats({ description, brief: brief() });
    for (const a of ATTRIBUTES) $(`n-a-${a}`).value = String(st.attributes[a] ?? 0);
    const extra = Object.fromEntries(Object.entries(st.attributes).filter(([k]) => !(ATTRIBUTES as readonly string[]).includes(k)));
    $("n-skills").value = fmtStats({ ...extra, ...st.skills });
    $("n-abilities").value = fmtStats(st.abilities);
    $("n-hp").value = String(st.hp);
    (document.querySelector('input[name="statsMode"][value="proposed"]') as HTMLInputElement).checked = true;
    updatePoints();
    nsay("Adjust as you like, then Start.");
  } catch (e) {
    nsay(errText(e));
  }
};
$("btn-n-cancel").onclick = () => showTab("world");
$("btn-n-start").onclick = async () => {
  const name = $("n-name").value.trim() || "New adventure";
  try {
    if ($<HTMLSelectElement>("n-template").value === "starter") {
      render(await game.newSave(name));
    } else {
      const b = brief();
      const d = draft ?? (await game.draftWorld({ brief: b, mode: "blank", place: $("n-place").value.trim() || undefined, room: $("n-room").value.trim() || undefined }));
      const keep = new Set([...document.querySelectorAll<HTMLInputElement>("#n-npc-list input:checked")].map((c) => Number(c.dataset.i)));
      const world = { ...d, opening: $<HTMLTextAreaElement>("n-opening").value.trim() || d.opening, npcs: draft ? d.npcs.filter((_, i) => keep.has(i)) : [] };
      const st = playerStats();
      render(
        await game.createAdventure({
          name,
          brief: b,
          world,
          statsMode: statsMode(),
          player: {
            name: $("n-pname").value.trim() || "You",
            age: Number($("n-age").value),
            description: $<HTMLTextAreaElement>("n-desc").value,
            ...st,
            hp: Number($("n-hp").value) || 10,
            coin: Number($("n-coin").value) || 0,
            items: $("n-items").value.split(",").map((x) => x.trim()).filter(Boolean),
          },
        }),
      );
    }
    draft = null;
    $("n-draft").hidden = true;
    nsay("");
    showTab("play");
  } catch (e) {
    nsay(errText(e));
  }
};
$("btn-save-dup").onclick = async () => {
  try {
    const cur = game.state().save;
    await game.duplicateSave(cur.id, $("save-name").value.trim() || `${cur.name} (copy)`);
    loadSaves();
    say("Copy saved.");
  } catch (e) {
    say(errText(e));
  }
};
$("btn-save-import").onclick = async () => {
  try {
    const f = await platform.importFile();
    if (!f) return;
    await game.importSave(f.name.replace(/\.db$/, "") || "Imported", f.data);
    loadSaves();
    say("Imported. Tap Load to play it.");
  } catch (e) {
    say(errText(e));
  }
};

// ---------- boot ----------
try {
  await initSqlite();
  game = await Game.open({ files: platform.files });
  $("boot-msg").hidden = true;
  $("app").hidden = false;
  render(game.state());
} catch (e) {
  $("boot-msg").textContent = `Failed to start: ${errText(e)}`;
}

$<HTMLInputElement>("s-length-range").oninput = () => {
  $<HTMLInputElement>("s-length").value = $<HTMLInputElement>("s-length-range").value;
};
$<HTMLInputElement>("s-length").oninput = () => {
  $<HTMLInputElement>("s-length-range").value = $<HTMLInputElement>("s-length").value;
};
