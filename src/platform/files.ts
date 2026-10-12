/** Minimal file access the app needs. Paths are relative to the app's data folder and use "/". */
export interface Files {
  read(path: string): Promise<Uint8Array | null>;
  /** Replaces the file atomically (write to a temp file, then rename). */
  write(path: string, data: Uint8Array): Promise<void>;
  list(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

/** In-memory Files, for tests and as a last-resort fallback. */
export class MemoryFiles implements Files {
  readonly data = new Map<string, Uint8Array>();
  async read(path: string) {
    const d = this.data.get(path);
    return d ? new Uint8Array(d) : null;
  }
  async write(path: string, data: Uint8Array) {
    this.data.set(path, new Uint8Array(data));
  }
  async list(dir: string) {
    const prefix = `${dir}/`;
    return [...this.data.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
  }
  async rename(from: string, to: string) {
    const d = this.data.get(from);
    if (!d) throw new Error("no such file");
    this.data.set(to, d);
    this.data.delete(from);
  }
  async remove(path: string) {
    this.data.delete(path);
  }
  async mkdir() {}
}
