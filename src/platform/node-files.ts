import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Files } from "./files.js";

/** Files rooted at a directory on disk (tests, and running the engine under Node). */
export class NodeFiles implements Files {
  constructor(private readonly root: string) {}
  private p(path: string) {
    return join(this.root, ...path.split("/"));
  }
  async read(path: string) {
    try {
      return new Uint8Array(await readFile(this.p(path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async write(path: string, data: Uint8Array) {
    const tmp = `${this.p(path)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, this.p(path));
  }
  async list(dir: string) {
    try {
      return await readdir(this.p(dir));
    } catch {
      return [];
    }
  }
  async rename(from: string, to: string) {
    await rename(this.p(from), this.p(to));
  }
  async remove(path: string) {
    await rm(this.p(path), { force: true });
  }
  async mkdir(dir: string) {
    await mkdir(this.p(dir), { recursive: true });
  }
}
