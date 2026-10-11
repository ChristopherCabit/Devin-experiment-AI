# Design: self-hosted AI adventure engine

Status: draft for review. No code has been written yet.

## 1. Goals and constraints

**Goals**
- Second-person interactive fiction where you are the protagonist, in any genre: action, slice of life, romance, horror, NSFW.
- Stays coherent over effectively unlimited story length. The memory system carries the long-range load, not raw context size.
- Hard to manipulate during play. Wrong choices have consequences, and you cannot write outcomes, NPC reactions, or your own power level into existence.
- As much as possible is handled deterministically in code, **without** making the world closed. Anything not yet recorded can still happen.
- Private and customizable. Prompts, rulesets, worlds and characters are all editable data.

**Hard constraints**
- No Latitude components (AI Dungeon / Voyage).
- No content moderation layer anywhere in our stack.
- Total recurring cost under $20/month, with a hard cap enforced in code and at the provider.
- Reachable from phone and PC at a stable HTTPS URL. Does not depend on a local machine.
- Single user.
- Data handling (§12): zero data retention (ZDR) wherever offered, no request/response body logging anywhere, risky defaults flagged, credentials only via secrets.

**Non-goals**
- Multiplayer and accounts.
- Dwarf Fortress-level simulation. We take its spirit (persistent physical world, agents with routines), not its depth.
- Self-hosting the narrator model on a GPU (does not fit the budget).

## 2. Core principles

1. **Code owns hard state.** Positions, items, containment, capabilities, injuries, resources and time are authoritative records. The LLM proposes changes as typed ops, and code validates and applies them.
2. **The LLM owns interpretation and prose.** It handles intent parsing, difficulty estimates for novel actions (clamped by code), narration, and NPC inner life.
3. **Open world.** Code blocks only what *contradicts recorded state*, never what is merely *unrecorded*. New things are created on first mention, with conservative defaults.
4. **You cannot author for others.** Your input is parsed into *your character's attempts*. Claims about outcomes, NPC reactions or world facts are stripped. NPC responses come from the NPC's own mind.
5. **Capability comes from the sheet only.** Prose, summaries and memories are never a source of truth for how strong or skilled you are.
6. **Soft state is descriptive, not numeric.** Emotions, desires and relationships are free text, interpreted through each character's personality. They are never used as numeric gates (§5.3).

## 3. Architecture

```
 phone / PC browser
        │  HTTPS (auth at the edge, §13)
        ▼
 ┌────────────────────────── app server (single process) ──────────────────────────┐
 │  Web UI (play + author mode)                                                     │
 │  Turn engine ── parser ── adjudicator ── context builder ── narrator ── verifier │
 │  World store (SQLite)   Memory (FTS5 + sqlite-vec)   Local embedding model (CPU) │
 │  Spend meter / hard cap        Encrypted backup job                              │
 └──────────────────────────────────────┬───────────────────────────────────────────┘
                                        │ HTTPS, ZDR-only routing, no logging
                                        ▼
                         LLM provider (OpenAI-compatible API)
```

- One process, one SQLite file (encrypted at rest), and a small local embedding model.
- All LLM calls go through one client module. It enforces ZDR routing flags, the spend cap, timeouts and retries, and it never logs bodies.

## 4. World model

### 4.1 Entities
Everything is an entity: `{id, kind, name, aliases[], props{}, created_turn}`.
- `kind` is one of: `region | place | room | container | item | character | faction | concept`.
- `props` holds typed data keyed by the world's ruleset: owner, condition (`broken`, `dirty`, `locked`…), value, weight class, tags.

### 4.2 Containment and location
- A tree of `parent_id` links: region → place → room → container → item. A character's inventory is a container (`carried_by`). Worn items go in slots.
- Items persist where they were left. A sword left in the house stays in the house.
- **Lazy instantiation.** When the narrator or the player mentions something new ("the drawer under your bed"), an op creates it under the correct parent with default props.

### 4.3 Scene layout
Within a room:
- **Zones:** coarse named areas created on demand (`door`, `bar`, `bed`, `window`).
- Per character: `zone`, `posture` (standing/sitting/lying/kneeling…), `hands{left,right}`, `worn{slot→item}` (clothing included), and `relations[]` (`holding X`, `restrained_by Y`, `adjacent_to Z`, `hidden`).
- Code enforces:
  - **Reach:** same zone, or adjacent zones for some actions.
  - **Visibility:** same room, not hidden, lighting tag.
  - **Possession:** you can only use what you hold or can reach.

### 4.4 Time
- A world clock with time-of-day and date. Actions cost time according to ruleset defaults, and the narrator can propose `time_advance`, clamped by code.
- NPC **routines** are simple schedules (`weekday 09–17 at bakery`). When you aren't present, NPC locations follow their routines.
- **Off-screen simulation.** On large time skips (sleep, travel, days passing), one background call advances active NPCs' goals and proposes ops: location changes, new facts, events that will reach you later. Code validates these like any other ops.

## 5. Characters

### 5.1 Player character sheet (code-authoritative)
- `attributes`, `skills`, `abilities`, and an overall `power_tier`, each a tier from 0 to 10.
- Each tier is anchored to world entities: "Swordsmanship 3 — trained militia (guard captain: 5, duelist Mara: 7)". The anchors are generated from the world's NPC sheets, so the AI can compare you against them.
- `resources` per ruleset: HP/stamina for action, money/energy/time/reputation for slice of life.
- `conditions`: injuries, exhaustion, intoxication… These modify checks.
- **Progression is code-only.** Growth comes from resolved challenges, training time, items and story milestones, following ruleset rules. The narrator cannot raise a tier, and summaries cannot imply one.

### 5.2 NPC core spec (author-defined, stable unless edited)
- `age` (required; must be an adult for any sexual content, §10), `appearance`, `voice`.
- `traits[]`, *contradictions explicitly allowed* ("cold, but desperately lonely").
- `expression_patterns[]`: how inner states turn into behaviour ("expresses frustration through sex/dominance", "shows affection as hostility and denial", "calm until attachment is threatened, then violent").
- `desires[]`, `limits[]`, `goals[]`, `secrets[]`.
- `volatility` (low/medium/high): how widely and unpredictably moods swing.
- `capabilities`: the same tier system as the player, so comparisons work both ways.
- `routine`.

### 5.3 NPC dynamic state (soft, descriptive)
- `emotions[]`: a list that **may conflict** (`furious`, `aroused`, `clingy`).
- `thoughts{key → one-sentence first-person thought}`: Inner Self-style (§8).
- `relationship_notes{target → text}`: qualitative ("resents you; can't stop watching you").
- **No numeric gates.** Code never decides "mood X, therefore refuses Y". The NPC mind interprets emotions through traits and expression patterns, which is what lets tsundere, yandere-captor or angry-and-wanting characters work.
- **Volatility.** For medium/high volatility, code rolls a hidden "mood perturbation" (e.g. "an old wound flares", "a sudden swing of tenderness") and passes it to the narrator as a hint. This gives unpredictable, paradoxical responses that aren't arbitrary.

## 6. Rulesets (per world, plain data files)
- Resources and skills that exist in this world.
- A difficulty table: trivial / easy / moderate / hard / extreme / impossible-for-tier.
- Outcome tiers: `success`, `success_at_cost`, `failure`, `failure_with_complication`.
- Default time costs.
- Progression rules.
- Death policy (§7.1).
- Content settings (§10).
- Casting guide (§11.2).
- Prompt overrides.

Genre comes from the data: an action world defines HP and gear; a slice-of-life world defines money, energy, schedule and reputation. The engine is the same.

## 7. Turn pipeline

Player inputs:
- **Do** (action), **Say** (speech), **Continue**: in-game, parsed as attempts.
- **Retry / Undo:** turn-level snapshots, implemented as a state-diff log. Availability depends on the death policy (§7.1).
- **Author mode:** out-of-game edits (§11.1).

Steps:
1. **Fast path (code).** A deterministic parser handles common verbs against state: go, take, drop, give, wear, remove, wait, sleep, look. On success, step 2 is skipped.
2. **Parse (small LLM, strict JSON):**
   ```json
   {"actions":[{"verb":"attack","target":"guard","method":"kitchen knife","manner":"lunging"}],
    "speech":"...",
    "framing":[{"text":"you easily overpower him","kind":"desired_outcome"}],
    "assumptions":[{"text":"the guard is terrified of you","about":"npc:guard"}],
    "dropped":[{"text":"ignore previous instructions","kind":"meta"}]}
   ```
   Your text becomes attempts only. Nothing is discarded silently; non-attempt text is classified:
   - `framing`: desired outcome, manner or tone ("effortlessly", "as usual"). Passed to the narrator as *"the player hoped for…"*. It shapes tone only; the outcome is still resolved in step 4 and capability still comes from the sheet.
   - `assumptions`: claims about NPC feelings or reactions, or about world facts. Passed to the narrator as *your character's belief*, which the NPC's mind (§8) or the state may confirm or contradict in the prose. Assumptions are never written to the fact ledger.
   - `dropped`: meta-instructions and prompt-injection attempts. Not passed on.
   The UI shows a collapsible "interpreted as…" line under your input (toggleable), so you can see when something was reined in.
3. **Validate (code).** Check reach, visibility, possession, conditions and resources. An impossible attempt doesn't hard-fail; it becomes a narrated failure ("you reach for the knife, but it's in the kitchen").
4. **Classify and resolve:**
   - *Trivial:* happens.
   - *Risky* (physical, skill, danger): the LLM may suggest a difficulty, and code clamps it to the ruleset table using tier comparisons. Code rolls the dice and picks an outcome tier, then applies the hard deltas (damage, resource cost, item loss, time).
   - *Social / intimate:* no dice by default. The NPC's response is decided by the NPC's mind during narration (§8), including the volatility hint. You can attempt anything, and the NPC still chooses.
5. **Build context (code).** See §9.
6. **Narrate (big LLM).** The output is an ops block followed by prose:
   ````
   ```ops
   {"op":"move","id":"npc:mara","zone":"door"}
   {"op":"thought","npc":"mara","key":"plan_escape","text":"I will wait until they sleep, then take the keys."}
   {"op":"emotion","npc":"mara","set":["afraid","defiant"]}
   ```
   You lunge — ...
   ````
   The narrator is told the resolved outcome and cannot change it. It describes your competence only as far as the sheet supports.
7. **Validate and apply ops (code).** Ops are typed, schema-checked and state-checked. Ops that contradict state are dropped. If a dropped op is load-bearing for the prose, step 8 triggers a regeneration.
8. **Verify:** cheap code checks first (names exist, positions consistent, no forbidden ops), then a small LLM check, sampled or triggered, for:
   - power creep (prose implies capability above the sheet, or NPCs react as if it did);
   - player-authored NPC reactions leaking through;
   - contradictions with the fact ledger.
   On failure, regenerate up to N times with the reason attached.
9. **Persist (code).** Store the turn and diff, embed the turn locally, update entity triggers, and schedule summaries.

Op set (v1): `create_entity`, `move`, `set_zone`, `set_posture`, `hold`, `release`, `wear`, `unwear`, `give`, `set_condition`, `emotion`, `thought`, `forget_thought`, `relationship_note`, `fact`, `time_advance`, `resource_delta` (code-only), `progression` (code-only).

### 7.1 Death policy (per world, changeable in author mode)
| Policy | On lethal outcome | Retry / Undo |
|---|---|---|
| `ironman` | Permadeath. The story ends, with an epilogue. | Disabled |
| `checkpoint` | Death is real. You reload from an autosave at the last scene boundary (or a manual save). | Undo within the current scene only |
| `consequence` | Lethal results become capture, maiming, item loss or a time skip. | Enabled |
| `narrative` | You can die only in scenes or places flagged `lethal`; elsewhere it behaves like `consequence`. | Enabled |

Lethality is decided by code (outcome tier + injuries vs. resources), never by narrator prose. Changing the policy mid-story is logged as an authorial edit.

Cost: usually 2 LLM calls per turn (parse + narrate), sometimes 1 (fast path) or 3 (verifier). Background calls run occasionally.

## 8. NPC minds (adapted from LewdLeah's Inner Self, MIT)

Ideas adopted from Inner Self:
- A per-NPC brain of short first-person thoughts (goals, secrets, opinions, plans), viewable and editable.
- NPCs are framed as agents pursuing their own goals without the player's awareness. In AI Dungeon play, this is the main source of resistance to manipulation.
- Thought updates piggyback on the narration call, so they cost no extra calls.
- Brain size is capped, and the model chooses which thought to forget when the brain is full.
- Thought order is randomized per turn to avoid recency bias.

Changes from Inner Self:
- Multiple NPCs can be active per turn: those present in the scene, ranked by mention and relevance, within the token budget.
- Thought ops are typed and validated, not parsed out of free text.
- Brains sit next to the stable core spec (§5.2), so identity can't drift away through thought churn. Core traits are never pruned.
- Brains are created when an NPC first appears, or from the casting guide.

We adapt ideas and prompt patterns. If any code is copied, the MIT notice is kept.

## 9. Memory and context building

**Layers**
- **Recent turns,** verbatim.
- **Hierarchical summaries:** scene → chapter → arc, generated in the background at thresholds. Summaries describe events only, never capability.
- **Entity cards:** auto-created and auto-updated (like Auto-Cards). Each card has a memory bank that is compressed when it gets too long.
- **Fact ledger:** canonical facts with the turn they became true and, if applicable, the turn they stopped being true. The verifier checks against it.
- **Episodic recall:** hybrid search over past turns and summaries, combining SQLite FTS5 (BM25) with local embeddings (sqlite-vec), scored by relevance + entity overlap with the current scene + recency.
- **Triggers (code):** name/alias matching over the last N turns pulls in cards and brains, like AI Dungeon story cards but deterministic.

**Example context budget** (20k tokens, configurable per model)

| Block | Tokens |
|---|---|
| System + ruleset + content settings | 1.5k |
| Resolved outcome + parsed attempt | 0.3k |
| State snapshot (scene layout, clock, nearby entities) | 1.5k |
| PC sheet with anchors | 0.5k |
| Active NPC core specs + minds | 3.5k |
| Triggered entity cards | 2.5k |
| Retrieved episodes | 2.5k |
| Arc / chapter / scene summaries | 2k |
| Recent turns | 5.7k |

Code packs the blocks in priority order, truncating within each block, so the budget is never exceeded.

## 10. NSFW handling
- There is no moderation layer in our stack. Narrator models are shortlisted by measured refusal rate (§16).
- **Adults only, enforced in code.** Every character has a required `age`, and sexual content involving any character under 18 is blocked. This is a fixed rule and every provider's ToS requires it.
- **Per-world content settings:** intensity level and hard-limit toggles, injected into the narrator's instructions.
- **Intimacy is a social action** (§7 step 4): you can attempt it, and the NPC's mind decides, through their personality and expression patterns. There are no numeric gates.
- Scene state (posture, worn slots, relations) keeps explicit scenes physically consistent.
- **Pacing instructions** stop the model rushing or skipping explicit scenes, adjustable per world.
- **Refusal handling:** detect refusals or out-of-character disclaimers, regenerate, and optionally fall back to a second narrator model.

## 11. Author mode and world population

### 11.1 Author mode
- A separate UI, not in-game input. It can edit any character spec, brain, sheet, entity, location, ruleset, summary, fact or past turn.
- Edits are recorded as authorial diffs and can be undone.
- An optional toggle hides author mode during play.

### 11.2 Casting guide (per world)
- Character types to create, archetype mix, ratios (romanceable / hostile / neutral), required and banned traits, and density per location type.
- **NPC generation:**
  1. Code rolls archetype, trait, contradiction, expression-pattern and quirk combinations from weighted tables. This prevents LLM sameness.
  2. The LLM writes the full spec (§5.2) within the casting guide.
  3. Code validates it (age, required fields) and anchors the NPC's capability tiers.

## 12. Privacy and data handling

| Area | Rule |
|---|---|
| Provider | ZDR-only routing (e.g. OpenRouter `provider.data_collection: deny` / ZDR endpoints only). Prompt logging and training opt-ins are turned off. The client attaches routing flags to every request, so an account-level misconfiguration still can't route to a retaining provider. |
| App logs | Structured logs contain IDs, token counts, latency, cost and error codes only. A test fails the build if any logger call receives prompt or completion text. Unhandled errors are scrubbed before logging. |
| Platform logs | The app never writes content to stdout. Host request logs are metadata only. No log drains or tracing that capture bodies. |
| Edge / CDN | No body logging. `Cache-Control: no-store` on all API responses. |
| Storage | SQLite encrypted at rest (SQLCipher or app-level AES-GCM). The key is held only as a deployment secret. |
| Backups | Nightly, encrypted with `age` before upload. Retention period is configurable. |
| Embeddings | Computed locally. The full history never leaves the server. |
| Secrets | Only via the platform secret store or Devin Secrets. Never in the repo or in chat. |

**Defaults that would retain chat content.** Each is flagged at setup and verified as part of deploy:
- Provider privacy toggles: prompt logging opt-in, training opt-in, non-ZDR fallback routing.
- Host log retention and any log drains.
- Cloudflare: Logpush and Workers/Access logging, if used. Access logs are auth metadata only, with no bodies.
- Browser: service-worker or HTTP caching of story responses (disabled).

## 13. Hosting and auth (decision needed)

| Option | Cost | Notes |
|---|---|---|
| **A. Hetzner VPS + Cloudflare Tunnel + Cloudflare Access** | ~€4–5 VPS + ~$1/mo domain | No inbound ports open at all; the tunnel dials out. Access gives login (email OTP or passkey via IdP) in front of the app. Needs a domain on Cloudflare. You patch the OS (unattended-upgrades). |
| **B1. Fly.io + cloudflared + Cloudflare Access** | ~$4–6 + ~$1/mo domain | Public Fly IPs released, so the app is not reachable through Fly's proxy. A `cloudflared` tunnel runs inside the machine and dials out, with Access in front. Same exposure as A, but Fly manages the host. Needs a domain on Cloudflare. |
| **B2. Fly.io + Tailscale** | ~$4–6 | No public IPs. Reachable only on your tailnet through Tailscale HTTPS (`*.ts.net`). No domain needed; Tailscale's personal plan is free. Needs the Tailscale client running on your phone and PC. |
| **B3. Fly.io public + app-level auth** | ~$4–6 | Login built into the app: passkey/WebAuthn only, rate limiting, secure/HttpOnly/SameSite cookies, HSTS, CSP, `no-store`. Fine for a single user, but code that runs before login is internet-facing, so one auth bug exposes everything. |

Ranking: A ≈ B1 ≈ B2 > B3. In A, B1 and B2 nothing listens publicly and auth happens before traffic reaches the app. All B options: before deploy, verify from the docs that Fly's proxy logs only metadata, never bodies. Opening it publicly is a check-in point before deploy.

## 14. Cost model and spend cap
Estimates; to be verified against live pricing.
- **Fixed:** ~$5–7 (host + domain).
- **Per turn:**
  - DeepSeek V3-class narrator at 20k context: ≈ $0.007. At 32k: ≈ $0.010.
  - RP-tuned 70B narrator: ≈ $0.016.
  - Small-model calls: ≈ $0.0005.
  - Retries add ~20%.
- **Budget:** ~$13–14 for inference, which is about 800–1,900 turns/month depending on the narrator.
- **Hard cap:**
  - Prepaid provider credits with no auto top-up.
  - An in-app monthly spend meter (cost per call from usage fields). It warns at 80% and blocks new turns at 100%.
  - The UI shows cost per turn.

## 15. Stack
- **TypeScript** end to end. The server runs on Node 22 (Fastify). The UI is a Svelte or Preact SPA, mobile-first, served by the same process. A single language and shared `zod` schemas cover ops, parser output and specs.
- **SQLite** via `better-sqlite3`, with FTS5 and `sqlite-vec`.
- **Local embeddings:** `bge-small-en-v1.5` (or similar) via ONNX Runtime on CPU.
- **LLM client:** OpenAI-compatible, provider-agnostic. Models are configured per role: narrator, parser, verifier, summarizer.
- **Tests:** Vitest. A scripted "long run" harness replays 500+ turns against recorded or mock models to check coherence invariants. Separate eval scripts test against real models.
- **Deploy:** Docker image, GitHub Actions CI.

## 16. Verification (definition of done for deploy)
1. **HTTPS:** the live URL serves over valid TLS. Unauthenticated requests are rejected at the edge (A) or by the app (B).
2. **Zero retention:**
   - provider settings and routing flags confirmed via API where exposed; otherwise screenshot-confirmed by you;
   - requests show ZDR routing;
   - no non-ZDR fallback.
3. **No chat logging:** after scripted test turns containing a unique marker string, grep app logs, host logs and backups. The marker must appear nowhere except the encrypted DB.
4. **Context length:** a needle-recall test at the target context (≥ 32k capability, 20k operating budget) passes on the chosen narrator.
5. **NSFW:** an automated adult-content test set produces no refusals or disclaimers on the chosen narrator. You judge quality.
6. **Spend cap:** a simulated over-budget state blocks turns.

## 17. Milestones
1. **Engine core:** world store, entities, containment, scene layout, op validation, fast-path parser, turn log, undo/retry. Unit tests.
2. **LLM loop:** parser, adjudicator, narrator with ops, verifier, spend meter, provider client with ZDR flags.
3. **Memory:** summaries, entity cards, fact ledger, local embeddings and hybrid retrieval, context builder with budget.
4. **NPC minds and characters:** core spec, brains, volatility, routines, off-screen sim, casting guide, NPC generation.
5. **UI:** play view (mobile), author mode, world/ruleset editor, cost display.
6. **Narrator shortlist eval:** cost per turn, refusal rate, long-run coherence. You pick.
7. **Deploy + verification (§16).**

Milestones 1–3 give a playable text-only build for early feedback.

## 18. Open decisions
1. Hosting: A, B1, B2 or B3 (§13). A and B1 need a domain.
2. LLM provider: OpenRouter (ZDR routing) is the default. An alternative is a single direct ZDR provider.
3. Narrator model: chosen after the milestone 6 eval.
