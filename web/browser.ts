import type { Files } from "../src/platform/files.js";
import type { Platform } from "./platform.js";

/** IndexedDB-backed Files, used when the UI runs in a plain browser (development, or a PC without the desktop app). */
function idbFiles(): Files {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("adventure", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const s = (await db).transaction("files", mode).objectStore("files");
    return new Promise<T>((resolve, reject) => {
      const r = fn(s);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  };
  return {
    read: async (path) => ((await tx("readonly", (s) => s.get(path))) as Uint8Array | undefined) ?? null,
    write: async (path, data) => void (await tx("readwrite", (s) => s.put(new Uint8Array(data), path))),
    list: async (dir) =>
      ((await tx("readonly", (s) => s.getAllKeys())) as string[])
        .filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/"))
        .map((k) => k.slice(dir.length + 1)),
    async rename(from, to) {
      const d = (await tx("readonly", (s) => s.get(from))) as Uint8Array | undefined;
      if (!d) throw new Error("no such file");
      await tx("readwrite", (s) => s.put(d, to));
      await tx("readwrite", (s) => s.delete(from));
    },
    remove: async (path) => void (await tx("readwrite", (s) => s.delete(path))),
    mkdir: async () => {},
  };
}

export function browserPlatform(): Platform {
  return {
    files: idbFiles(),
    async exportFile(name, data) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return true;
    },
    importFile: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".db,application/octet-stream";
        input.onchange = async () => {
          const f = input.files?.[0];
          resolve(f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null);
        };
        input.click();
      }),
  };
}
