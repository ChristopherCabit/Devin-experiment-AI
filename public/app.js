"use strict";
const $ = (id) => document.getElementById(id);
const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) showLogin();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- auth ----------
function showLogin(msg = "") {
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-msg").textContent = msg;
}
async function register(code) {
  const opts = await api("POST", "/auth/register/options", { setupCode: code });
  const resp = await startRegistration({ optionsJSON: opts });
  await api("POST", "/auth/register/verify", resp);
}
$("btn-login").onclick = async () => {
  try {
    const opts = await api("POST", "/auth/login/options", {});
    const resp = await startAuthentication({ optionsJSON: opts });
    await api("POST", "/auth/login/verify", resp);
    boot();
  } catch (e) { $("login-msg").textContent = e.message; }
};
$("btn-register").onclick = async () => {
  try { await register($("setup-code").value); $("setup-code").value = ""; boot(); }
  catch (e) { $("login-msg").textContent = e.message; }
};
$("btn-add-passkey").onclick = async () => {
  try { await register(""); $("world-msg").textContent = "Passkey added."; }
  catch (e) { $("world-msg").textContent = e.message; }
};
$("btn-logout").onclick = async () => { await api("POST", "/auth/logout", {}); showLogin(); };

// ---------- play ----------
function clockText(m) {
  const d = Math.floor(m / 1440) + 1, h = String(Math.floor((m % 1440) / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0");
  return `Day ${d} ${h}:${mm}`;
}
function render(s) {
  $("title").textContent = s.settings.title;
  const hp = s.sheet?.resources?.hp;
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
    if (t.output) { const p = document.createElement("p"); p.textContent = t.output; story.append(p); }
  }
  story.scrollTop = story.scrollHeight;
  $("spend").textContent = `Spend this month: $${s.spend.spent.toFixed(3)} of $${s.spend.cap}` + (s.spend.warn ? " (near cap)" : "");
  const sh = s.sheet;
  if (sh) {
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
    $("sheet").textContent = `Sheet: power ${sh.power_tier}; ${fmt(sh.attributes)}; ${fmt(sh.skills)}`;
  }
}
function busy(on) { for (const id of ["btn-send", "btn-undo", "btn-retry"]) $(id).disabled = on; }

$("turn-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const kind = document.querySelector('input[name="kind"]:checked').value;
  const input = $("input").value.trim();
  if (!input && kind !== "continue") return;
  busy(true);
  const pending = document.createElement("p");
  pending.className = "pending";
  pending.textContent = "…";
  $("story").append(pending);
  $("story").scrollTop = $("story").scrollHeight;
  try {
    const out = await api("POST", "/api/turn", { kind, input });
    $("input").value = "";
    render(out.state);
    $("interpreted").textContent = [out.interpreted ? `Interpreted as: ${out.interpreted}` : "", out.rejected.length ? `Engine rejected: ${out.rejected.join("; ")}` : ""].filter(Boolean).join(" · ");
  } catch (e) { pending.remove(); $("interpreted").textContent = e.message; }
  busy(false);
};
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); $("turn-form").requestSubmit(); } });
$("btn-undo").onclick = async () => {
  busy(true);
  try { render(await api("POST", "/api/undo", {})); $("interpreted").textContent = ""; } catch (e) { $("interpreted").textContent = e.message; }
  busy(false);
};
$("btn-retry").onclick = async () => {
  busy(true);
  try { const out = await api("POST", "/api/retry", {}); render(out.state); $("interpreted").textContent = out.interpreted ? `Interpreted as: ${out.interpreted}` : ""; }
  catch (e) { $("interpreted").textContent = e.message; }
  busy(false);
};

// ---------- tabs ----------
for (const b of document.querySelectorAll("nav button")) {
  b.onclick = () => {
    for (const x of document.querySelectorAll("nav button")) x.classList.toggle("active", x === b);
    for (const t of document.querySelectorAll(".tab")) t.hidden = t.id !== `tab-${b.dataset.tab}`;
    if (b.dataset.tab === "cast") loadEntities();
    if (b.dataset.tab === "world") loadSettings();
  };
}

// ---------- author mode ----------
let entities = [];
async function loadEntities(selectId) {
  entities = await api("GET", "/api/entities");
  const sel = $("entity-select");
  const keep = selectId || sel.value;
  sel.replaceChildren(...entities.filter((e) => e.kind !== "region").map((e) => new Option(`${e.name} (${e.id})`, e.id)));
  if (keep) sel.value = keep;
  showEntity();
}
function showEntity() {
  const e = entities.find((x) => x.id === $("entity-select").value);
  if (!e) return;
  $("entity-name").value = e.name;
  $("entity-aliases").value = e.aliases.join(", ");
  $("entity-props").value = JSON.stringify(e.props, null, 2);
}
$("entity-select").onchange = showEntity;
$("btn-entity-save").onclick = async () => {
  try {
    const props = JSON.parse($("entity-props").value);
    const aliases = $("entity-aliases").value.split(",").map((s) => s.trim()).filter(Boolean);
    const id = $("entity-select").value;
    await api("PUT", `/api/entities/${encodeURIComponent(id)}`, { name: $("entity-name").value, aliases, props });
    $("cast-msg").textContent = "Saved.";
    loadEntities(id);
  } catch (e) { $("cast-msg").textContent = e.message; }
};
$("btn-entity-add").onclick = async () => {
  try {
    const kind = $("new-kind").value;
    const body = { kind, name: $("new-name").value, parent: $("new-parent").value || undefined };
    if (kind === "character") body.props = { age: 25 };
    const e = await api("POST", "/api/entities", body);
    $("cast-msg").textContent = `Created ${e.id}.`;
    loadEntities(e.id);
  } catch (e) { $("cast-msg").textContent = e.message; }
};

const SETTINGS = ["title", "premise", "style", "intensity", "limits", "deathPolicy", "narratorModel", "parserModel", "contextTokens"];
async function loadSettings() {
  const s = await api("GET", "/api/settings");
  for (const k of SETTINGS) $(`s-${k}`).value = s[k];
}
$("btn-settings-save").onclick = async () => {
  const body = {};
  for (const k of SETTINGS) body[k] = k === "contextTokens" ? Number($(`s-${k}`).value) : $(`s-${k}`).value;
  try { await api("PUT", "/api/settings", body); $("world-msg").textContent = "Saved."; render(await api("GET", "/api/state")); }
  catch (e) { $("world-msg").textContent = e.message; }
};
$("btn-new-world").onclick = async () => {
  if (!confirm("Start a new world? This deletes the current story.")) return;
  try { render(await api("POST", "/api/world/new", { confirm: true })); $("world-msg").textContent = "New world started."; }
  catch (e) { $("world-msg").textContent = e.message; }
};

// ---------- boot ----------
async function boot() {
  const st = await api("GET", "/auth/status");
  if (!st.loggedIn) {
    $("register-box").open = !st.registered;
    $("register-box").hidden = st.registered;
    return showLogin(st.locked ? "Too many failed attempts; try again later." : "");
  }
  $("login").hidden = true;
  $("app").hidden = false;
  render(await api("GET", "/api/state"));
}
boot();
