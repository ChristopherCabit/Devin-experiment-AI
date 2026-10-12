import type { Files } from "../src/platform/files.js";

export interface Platform {
  files: Files;
  /** Lets the user save a file outside the app. Resolves false if they cancel. */
  exportFile(name: string, data: Uint8Array): Promise<boolean>;
  /** Lets the user pick a file. Resolves null if they cancel. */
  importFile(): Promise<{ name: string; data: Uint8Array } | null>;
}

export async function detectPlatform(): Promise<Platform> {
  if ("__TAURI_INTERNALS__" in window) return (await import("./tauri.js")).tauriPlatform();
  return (await import("./browser.js")).browserPlatform();
}
