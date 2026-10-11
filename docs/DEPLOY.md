# Deploying and operating

The app runs on one Fly.io machine (`adv-d25197`, region `iad`) with one encrypted volume, `game_data`, mounted at `/data`.

## One-time setup

```sh
curl -L https://fly.io/install.sh | sh   # or: brew install flyctl
fly auth login                            # opens a browser
```

## Deploy

From the repo root, on the branch you want live:

```sh
npm ci && npm run check                   # lint, typecheck, tests
fly deploy --app adv-d25197 --ha=false
```

`--ha=false` keeps it to one machine, which SQLite needs. The build runs on Fly's remote builder, so Docker isn't required (add `--local-only` if you'd rather build locally with Docker). On startup the app upgrades every save it opens and backs each one up before doing so (see "Data").

Check it:

```sh
fly status --app adv-d25197
curl -sS https://adv-d25197.fly.dev/healthz   # {"ok":true}
fly logs --app adv-d25197                     # metadata only: method, route, status, ms
```

## Secrets

Set secrets in your own terminal, never in chat or in files:

```sh
fly secrets list --app adv-d25197
fly secrets set --app adv-d25197 OPENROUTER_API_KEY=...    # restarts the machine
```

| Secret | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Inference. Give the key a credit limit on OpenRouter. |
| `APP_SETUP_CODE` | Registers the first passkey. Not used again once a passkey exists. |
| `APP_ORIGIN` | `https://adv-d25197.fly.dev`. Change it if you add a custom domain. |

`MONTHLY_CAP_USD` (default 14) is the app's hard monthly inference cap and can be set the same way.

## Rollback

```sh
fly releases --app adv-d25197 --image          # lists previous images
fly deploy --app adv-d25197 --ha=false --image <image-from-list>
```

Rolling back code doesn't touch your saves. One caveat: if a newer version upgraded a save's format, older code refuses to open that save rather than damage it. The pre-upgrade copy is in `/data/backups`.

## Data

```
/data/main.db        passkeys, sessions, monthly spend, save index
/data/saves/*.db     one file per scenario
/data/backups/       automatic copy taken before any format upgrade (last 5 per save) + the pre-saves original
/data/deleted/       saves deleted in the UI: moved here, never erased
```

How saves are protected from updates:

1. **Append-only migrations.** The save format has a version (`SCHEMA_VERSION` in `src/world/store.ts`). A format change adds a migration step; existing steps are never edited and data is never dropped.
2. **Backup before upgrade.** The app copies a save to `/data/backups` before migrating it.
3. **Frozen fixture.** `test/fixtures/save-v1.db` is a real v1 save. CI fails if a change can't open it, play a turn and undo. When the format changes, add `save-v2.db` and keep the old fixtures.
4. **Fly volume snapshots.** Fly snapshots the volume daily and keeps 5. List them with `fly volumes list --app adv-d25197`, then `fly volumes snapshots list <volume-id>`. Restoring one creates a new volume (https://fly.io/docs/volumes/snapshots/).
5. **Your own copies.** World tab → Export downloads a save. Import loads it back, on this or any other deployment.

Recovering a single file from `backups/` or `deleted/`:

```sh
fly ssh sftp get /data/deleted/<file>.db ./restore.db --app adv-d25197
```

Then import `restore.db` from the World tab.

## Cost

The machine stops when idle and starts on the next request (the first load takes a few seconds). Expect roughly $0–3 per month for the machine and volume, plus inference, which is capped in the app.
