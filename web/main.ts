import { Game, type GameState } from "../src/app/game.js";
import { initSqlite } from "../src/db/sqlite.js";
import type { PlayKind, TurnOutput } from "../src/game/pipeline.js";
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
  $("interpreted").textContent = [out.interpreted ? `Interpreted as: ${out.interpreted}` : "", out.rejected.length ? `Engine rejected: ${out.rejected.join("; ")}` : ""]
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
    const out = await game.turn(kind, input);
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
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.onclick = () => {
    for (const x of document.querySelectorAll("nav button")) x.classList.toggle("active", x === b);
    for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.hidden = t.id !== `tab-${b.dataset.tab}`;
    if (b.dataset.tab === "cast") loadEntities();
    if (b.dataset.tab === "world") loadSettings();
  };
}

// ---------- author mode ----------
let entities: Entity[] = [];
function loadEntities(selectId?: string) {
  entities = game.entities();
  const sel = $<HTMLSelectElement>("entity-select");
  const keep = selectId || sel.value;
  sel.replaceChildren(...entities.filter((e) => e.kind !== "region").map((e) => new Option(`${e.name} (${e.id})`, e.id)));
  if (keep) sel.value = keep;
  showEntity();
}
function showEntity() {
  const e = entities.find((x) => x.id === $<HTMLSelectElement>("entity-select").value);
  if (!e) return;
  $("entity-name").value = e.name;
  $("entity-aliases").value = e.aliases.join(", ");
  $<HTMLTextAreaElement>("entity-props").value = JSON.stringify(e.props, null, 2);
}
$("entity-select").onchange = showEntity;
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
const SETTINGS = ["title", "premise", "style", "intensity", "limits", "deathPolicy", "narratorModel", "parserModel", "contextTokens"] as const;
const say = (m: string) => ($("world-msg").textContent = m);
function loadSettings() {
  const s = game.settings() as unknown as Record<string, unknown>;
  for (const k of SETTINGS) $(`s-${k}`).value = String(s[k]);
  const c = game.config();
  $("cfg-key").value = "";
  $("cfg-key").placeholder = c.hasKey ? "Key saved on this device (enter a new one to replace)" : "sk-or-…";
  $("cfg-cap").value = String(c.capUsd);
  loadSaves();
}
$("btn-settings-save").onclick = async () => {
  const body: Record<string, unknown> = {};
  for (const k of SETTINGS) body[k] = k === "contextTokens" ? Number($(`s-${k}`).value) : $(`s-${k}`).value;
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
$("btn-save-new").onclick = async () => {
  try {
    render(await game.newSave($("save-name").value.trim() || "New adventure"));
    loadSettings();
    say("New adventure started.");
  } catch (e) {
    say(errText(e));
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
