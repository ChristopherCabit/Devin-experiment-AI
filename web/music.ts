const FADE = 3;

/** Plays one looping track at a time through Web Audio, crossfading between tracks and across each loop seam. */
export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private key: string | null = null;
  private buf: AudioBuffer | null = null;
  private live: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt = 0;

  constructor() {
    // WebViews only start audio after a user gesture; resume on any tap or key so later tracks can play.
    const unlock = () => this.resume();
    addEventListener("pointerdown", unlock);
    addEventListener("keydown", unlock);
    const back = () => (document.hidden ? undefined : this.resume());
    document.addEventListener("visibilitychange", () => (document.hidden ? this.pause() : this.resume()));
    addEventListener("pagehide", () => this.pause());
    addEventListener("pageshow", back);
    addEventListener("focus", back);
  }

  get volume(): number {
    const v = Number(localStorage.getItem("music-volume") ?? "0.5");
    return Number.isFinite(v) ? v : 0.5;
  }

  setVolume(v: number) {
    localStorage.setItem("music-volume", String(v));
    if (this.master) this.master.gain.value = v;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async play(key: string, audio: Uint8Array) {
    if (key === this.key) return;
    this.key = key;
    const ctx = this.context();
    void ctx.resume().catch(() => undefined);
    const buf = await ctx.decodeAudioData(audio.slice().buffer);
    if (this.key !== key) return;
    this.fadeAll();
    this.buf = buf;
    this.start(ctx.currentTime + 0.05);
  }

  stop() {
    this.key = null;
    this.buf = null;
    this.fadeAll();
  }

  /** One pass of the track; the next pass starts a fade before this one ends, so the loop seam is a crossfade. */
  private start(at: number) {
    const { ctx, buf, master } = this;
    if (!ctx || !buf || !master) return;
    const fade = Math.min(FADE, buf.duration / 4);
    const end = at + buf.duration;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + fade);
    gain.gain.setValueAtTime(1, end - fade);
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(master);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start(at);
    src.stop(end);
    const node = { src, gain };
    this.live.push(node);
    src.onended = () => {
      this.live = this.live.filter((n) => n !== node);
      gain.disconnect();
    };
    this.nextAt = end - fade;
    this.arm();
  }

  private arm() {
    const { ctx, buf } = this;
    clearTimeout(this.timer);
    if (!ctx || !buf) return;
    const at = this.nextAt;
    this.timer = setTimeout(() => {
      if (this.buf === buf) this.start(at);
    }, Math.max(0, (at - ctx.currentTime - 1) * 1000));
  }

  /** Silences everything while the app is in the background; the audio clock stops, so the loop resumes where it was. */
  private pause() {
    clearTimeout(this.timer);
    void this.ctx?.suspend().catch(() => undefined);
  }

  private resume() {
    const ctx = this.ctx;
    if (!ctx || !this.key || document.hidden) return;
    if (ctx.state === "running") return this.arm();
    // Android may refuse until the next tap; the tap listener calls this again.
    void ctx.resume().then(() => this.arm(), () => undefined);
  }

  private fadeAll() {
    clearTimeout(this.timer);
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const { src, gain } of this.live) {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + FADE);
      try {
        src.stop(t + FADE);
      } catch {
        // already stopped
      }
    }
  }
}
