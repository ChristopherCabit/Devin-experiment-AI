import { open, save } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, mkdir, readDir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import type { Files } from "../src/platform/files.js";
import type { Platform } from "./platform.js";

const baseDir = BaseDirectory.AppData;

/** Files in the OS app-data folder (e.g. %APPDATA%, ~/.local/share, Android app storage). */
const files: Files = {
  async read(path) {
    try {
      return await readFile(path, { baseDir });
    } catch {
      return null;
    }
  },
  async write(path, data) {
    await writeFile(`${path}.tmp`, data, { baseDir });
    await rename(`${path}.tmp`, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
  },
  async list(dir) {
    try {
      return (await readDir(dir, { baseDir })).filter((e) => e.isFile).map((e) => e.name);
    } catch {
      return [];
    }
  },
  rename: (from, to) => rename(from, to, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir }),
  async remove(path) {
    await remove(path, { baseDir }).catch(() => undefined);
  },
  mkdir: (dir) => mkdir(dir, { baseDir, recursive: true }),
};

export function tauriPlatform(): Platform {
  return {
    files,
    async exportFile(name, data) {
      const ext = /\.(\w+)$/.exec(name)?.[1] ?? "db";
      const path = await save({ defaultPath: name, filters: [{ name: ext === "mp3" ? "MP3 audio" : "Adventure save", extensions: [ext] }] });
      if (!path) return false;
      await writeFile(path, data);
      return true;
    },
    async importFile() {
      const path = await open({ multiple: false, directory: false });
      if (!path) return null;
      const base = decodeURIComponent(path.split(/[\\/]/).pop() ?? "");
      return { name: /\.db$/i.test(base) ? base : "Imported", data: await readFile(path) };
    },
  };
}
