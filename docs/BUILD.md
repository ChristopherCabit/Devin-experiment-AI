# Building and running

Adventure is a local app: one TypeScript/web codebase (`src/`, `web/`) in a Tauri 2 shell (`src-tauri/`). Nothing is hosted. The only network traffic is model calls from the device to OpenRouter.

## Get a build

- **CI:** every push runs the *Build apps* workflow (`.github/workflows/build.yml`), which uploads an Android APK, a Linux `.deb`/AppImage and a Windows installer (`.msi`/`.exe`) as workflow artifacts. Download them from the run's page.
- **Locally:** see below.

## First run

1. Open World → App settings and paste an OpenRouter API key. Give the key a credit limit on OpenRouter; it is stored in the app's data folder on this device.
2. Set the monthly spend cap (default $14). The app refuses turns once it is reached.
3. Every request is sent with `provider: { zdr: true, data_collection: "deny" }` (zero-data-retention endpoints only). Also turn on OpenRouter's account-level ZDR setting and keep prompt logging off.

## Saves

- Stored in the OS app-data folder (`%APPDATA%\io.github.christophercabit.adventure` on Windows, `~/.local/share/io.github.christophercabit.adventure` on Linux, app-private storage on Android):
  - `main.db`: save index, spend meter, app settings (including the API key)
  - `saves/<id>.db`: one SQLite file per scenario
  - `backups/`: a copy of a save taken before its format is upgraded (last 5 per save)
  - `deleted/`: deleted saves are moved here, never erased
- **Moving saves between devices:** World → Export on one device, then Import on the other. The file format is the same on every platform, and exports from the old hosted server import fine.
- **Uninstalling the Android app deletes its data.** Export anything you want to keep first. Installing a new APK over the old one keeps the data only if both are signed with the same key.

## Local development

Requirements: Node 22, Rust (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. For Android you also need the Android SDK (platform 34), NDK 26 and JDK 17, with `ANDROID_HOME` and `NDK_HOME` set.

```sh
npm ci
npm run check                 # lint + typecheck + tests
npm run dev                   # UI in a browser at http://localhost:1420 (saves in IndexedDB)
npx tauri dev                 # desktop app
npx tauri build               # installers for this OS
npx tauri android build --apk --debug --target aarch64   # phone APK
```

## Format safety

- Save files carry a format version (`PRAGMA user_version`). Upgrades are append-only steps in `MIGRATIONS` (`src/world/store.ts`); a save is backed up before any upgrade runs.
- `test/fixtures/save-v1.db` is a frozen v1 save. CI fails if a change can't open it and play a turn. Never regenerate it; add a new fixture for each new format version.
