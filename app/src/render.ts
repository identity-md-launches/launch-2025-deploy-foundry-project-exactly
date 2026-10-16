import { ScreenCurve } from "./crt";
import { type Jackpot } from "./jackpot";
import { Board, footprint, key, DIRS, jackAt } from "./geometry";
import { Wiring, SPEED, PULSE_LIFETIME, pulsePower, arcPoints, pointAt, arcDist, type Arrival } from "./signals";
import { PARTS, CORE, UNIT, SEG, DIGIT, type Layer, type Anim } from "./parts.gen";

// CPU-friendly: every layer of every part is rasterized once per zoom level from its SVG (art/parts.mjs).
// Each frame draws those bitmaps; moving layers only get a transform, an opacity or a clip.
//
// Signals (signals.ts): every mint sends light from the core through the actual wiring. It runs around each
// module's border and jumps across the cable leads where jacks are plugged together. Clicking a part sends one
// from that part. Parts it passes speed up for a moment.
// A legendary reveal sets the whole machine off.

const LIT = "#39d353", ALARM = "#ff6b62", MINE = "#ff8a3d";
/** rarity colours (style.css --common .. --seat) */
const CORE_CELLS = [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y]));

export interface Ghost {
  design: number;
  rot: number;
  x: number;
  y: number;
  ok: boolean;
  draft?: boolean; // arranged, waiting for the build transaction
  selected?: boolean; // the draft the toolbar is on
}

/** current value of an animation at time t (seconds) */
function sample(a: Anim, t: number, values: number[]): number;
function sample(a: Anim, t: number, values: number[][]): number[];
function sample(a: Anim, t: number, values: any[]): any {
  const u = (((t / a.dur + (a.phase ?? 0)) % 1) + 1) % 1;
  const n = values.length;
  if (a.ease === "step") return values[Math.min(n - 1, Math.floor(u * n))];
  const x = u * (n - 1), i = Math.min(n - 2, Math.floor(x));
  let f = x - i;
  if (a.ease === "sin") f = (1 - Math.cos(Math.PI * f)) / 2;
  const lerp = (p: number, q: number) => p + (q - p) * f;
  return Array.isArray(values[0]) ? values[0].map((_: number, k: number) => lerp(values[i][k], values[i + 1][k])) : lerp(values[i], values[i + 1]);
}

/** layer bitmaps, rasterized lazily per scale bucket */
class Sprites {
  private imgs = new Map<string, HTMLImageElement>();
  private ready = new Set<string>();
  private bitmaps = new Map<string, HTMLCanvasElement>();
  private budget = 0;
  pending = true;

  constructor() {
    PARTS.forEach((p) => p.layers.forEach((l, i) => this.load(`${p.id}:${i}`, l, p.w, p.h)));
    CORE.forEach((l, i) => this.load(`core:${i}`, l, 3, 3));
  }

  private load(id: string, l: Layer, w: number, h: number) {
    const [x, y, bw, bh] = l.box ?? [0, 0, w * UNIT, h * UNIT];
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${bw} ${bh}" width="${bw}" height="${bh}">${l.svg}</svg>`);
    img.decode().then(() => this.ready.add(id), () => {});
    this.imgs.set(id, img);
  }

  /** call once per frame: limits how many bitmaps a zoom change rasterizes per frame */
  tick() {
    this.budget = 16;
    this.pending = false;
  }

  /** the bitmap of layer `id` for `pxPerUnit` device pixels per unit, or the nearest one already made */
  get(id: string, box: number[], pxPerUnit: number): CanvasImageSource | null {
    if (!this.ready.has(id)) {
      this.pending = true;
      return null;
    }
    const bucket = Math.max(-12, Math.min(9, Math.ceil(Math.log2(pxPerUnit) * 3)));
    const k = `${id}@${bucket}`;
    let c = this.bitmaps.get(k);
    if (c) return c;
    if (this.budget-- <= 0) {
      this.pending = true;
      for (let d = 1; d < 24; d++) {
        const near = this.bitmaps.get(`${id}@${bucket - d}`) ?? this.bitmaps.get(`${id}@${bucket + d}`);
        if (near) return near;
      }
      return null;
    }
    const s = 2 ** (bucket / 3);
    c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(box[2] * s));
    c.height = Math.max(1, Math.ceil(box[3] * s));
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.imgs.get(id)!, 0, 0, c.width, c.height);
    this.bitmaps.set(k, c);
    return c;
  }
}

const TAIL = 1.4; // cells of fading light behind a signal's front
const DETAIL_IN = 24, DETAIL_OUT = 20; // zoom hysteresis avoids flickering between tiles and layers
const TILE = 16; // cells per side of a cached tile when zoomed out
const TILE_RENDERS = 6; // tiles rendered per frame at most

/** the bounding box of a footprint: x, y, width, height in cells */
function bboxOf(fp: number[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of fp) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

interface Pulse { t: number; arr: Map<number, Arrival> }

export class Renderer {
  jackpot: Jackpot | null = null;
  ctx: CanvasRenderingContext2D;
  cam = { x: 0.5, y: 0.5, z: 2.2 };
  cell = 24; // screen px per grid cell at zoom 1
  ghost: Ghost | null = null;
  /** empty cells where the picked part can plug in (shown while placing) */
  hints: [number, number][] = [];
  hover: number | null = null;
  picked: number | null = null; // the part whose card is open
  selected: number | null = null; // a selected draft
  me = "";
  time = 0;
  reducedMotion = false;
  private performance = false;
  private detailed = true;
  private snapshot = "";
  private needsFrame = true;
  private sprites = new Sprites();
  private curve: ScreenCurve;
  private dpr = 1;
  private dt = 0;
  private pulses: Pulse[] = [];
  private fresh = new Map<number, number>();
  private clocks = new Map<number, number>(); // each part's own animation time (it runs faster when energized)
  private alarm = 0;
  private wiring: Wiring;
  // zoomed-out tiles: which parts touch each tile, and each tile's bitmap at the current scale
  private tileParts = new Map<string, number[]>();
  private tileIndexed = new Set<number>();
  private tileEpoch = -1;
  private tileBitmaps = new Map<string, HTMLCanvasElement>();
  private tileScale = 0;
  /** live numbers shown by parts with a display */
  stats = { minted: 0, paid: 0 };
  private last = 0;

  constructor(public canvas: HTMLCanvasElement, public board: Board, crt = true) {
    this.curve = new ScreenCurve(crt);
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.wiring = new Wiring(board);
  }

  get cs() {
    return this.cell * this.cam.z;
  }

  get performanceMode() { return this.performance; }
  set performanceMode(on: boolean) {
    if (on === this.performance) return;
    this.performance = on;
    this.pulses = [];
    this.fresh.clear();
    this.alarm = 0;
    this.resize();
  }
  // Kept for the existing performance harness. Motion never changes based on frame cost.
  get lowMotion() { return this.performance || this.reducedMotion; }
  set lowMotion(on: boolean) { this.performanceMode = on; }
  get detailMode() { return this.detailed ? "Detail" : "Overview"; }
  get crtEnabled() { return this.curve.enabled; }
  set crtEnabled(on: boolean) { this.curve.enabled = on; }

  resize() {
    // Supersample standard displays too; fine wires otherwise alias during fractional zoom.
    this.dpr = this.performance ? 1 : Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.curve.resize(r.width, r.height);
    this.last = 0;
    this.needsFrame = true;
  }

  /** Public coordinates include the CRT warp; drawing uses the flat projection below. */
  toScreen(wx: number, wy: number): [number, number] {
    return this.curve.flatToScreen(...this.project(wx, wy));
  }

  toWorld(sx: number, sy: number): [number, number] {
    return this.unproject(...this.screenToFlat(sx, sy));
  }

  screenToFlat(sx: number, sy: number): [number, number] {
    return this.curve.screenToFlat(sx, sy);
  }

  private project(wx: number, wy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(wx - this.cam.x) * this.cs + r.width / 2, (wy - this.cam.y) * this.cs + r.height / 2];
  }

  private unproject(sx: number, sy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(sx - r.width / 2) / this.cs + this.cam.x, (sy - r.height / 2) / this.cs + this.cam.y];
  }

  /** the draft under a world point, if any */
  draftAt(wx: number, wy: number): number | null {
    const fx = Math.floor(wx), fy = Math.floor(wy);
    for (const d of this.board.drafts.values()) if (d.fp.some(([x, y]) => x === fx && y === fy)) return d.id;
    return null;
  }

  partAt(wx: number, wy: number): number | null {
    const c = this.board.cells.get(key(Math.floor(wx), Math.floor(wy)));
    return c ? c.id : null;
  }

  /** a signal from part `src` (0 = the core) through the wiring */
  pulse(src = 0) {
    if (this.lowMotion) return;
    const arr = this.wiring.arrivals(src);
    this.pulses.push({ t: 0, arr });
    if (this.pulses.length > 8) this.pulses.shift();
  }

  placed(id: number) {
    if (this.lowMotion) return;
    this.fresh.set(id, 1);
  }

  /** a legendary reveal: the whole machine flashes and three signals go out */
  celebrate() {
    if (this.lowMotion) return;
    this.alarm = 1.8;
    [0, 350, 700].forEach((ms) => setTimeout(() => this.pulse(0), ms));
  }

  /** how strongly passing signals drive part `id` right now (0..1): it peaks as the light arrives */
  energy(id: number) {
    if (this.lowMotion) return 0;
    let e = 0;
    for (const p of this.pulses) {
      const a = p.arr.get(id);
      if (!a) continue;
      const dt = p.t - a.t;
      if (dt >= 0 && dt < 0.9) e = Math.max(e, (1 - dt / 0.9) * pulsePower(p.t));
    }
    return e;
  }

  /** the light itself, drawn over all parts: fronts with fading tails along borders, and flashing leads */
  private signals() {
    if (this.lowMotion || !this.pulses.length) return;
    const ctx = this.ctx, cs = this.cs;
    const w = Math.max(1.3, (2.2 / UNIT) * cs);
    const toS = (p: [number, number]) => this.project(p[0], p[1]);
    const stroke = (pts: [number, number][], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(...toS(q)) : ctx.moveTo(...toS(q))));
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.pulses) {
      ctx.globalAlpha = pulsePower(p.t);
      for (const [id, a] of p.arr) {
        const l = this.wiring.loops.get(id);
        if (!l) continue;
        const dt = p.t - a.t;
        if (dt < 0) continue;
        if (a.s === null) {
          // the source: its whole frame flashes
          const k = 1 - dt / 0.6;
          if (k > 0) {
            const all = arcPoints(l, 0, l.len);
            stroke(all, `rgba(57,211,83,${0.35 * k})`, w * 3.2);
            stroke(all, `rgba(176,237,186,${k})`, w);
          }
        } else {
          const d = dt * SPEED, half = l.len / 2;
          if (d - TAIL < half) {
            for (const dir of [1, -1]) {
              const front = Math.min(d, half), back = Math.max(0, d - TAIL);
              if (front <= back) continue;
              const seg = (u: number, v: number) => (dir > 0 ? arcPoints(l, a.s! + u, a.s! + v) : arcPoints(l, a.s! - v + l.len, a.s! - u + l.len));
              stroke(seg(back, front), "rgba(57,211,83,0.22)", w * 3.2);
              [0.18, 0.4, 0.75].forEach((alpha, i) => stroke(seg(back + ((front - back) * i) / 3, back + ((front - back) * (i + 1)) / 3), `rgba(57,211,83,${alpha})`, w));
              if (d < half) {
                const [hx, hy] = toS(pointAt(l, a.s! + dir * front));
                ctx.fillStyle = "rgba(200,255,210,0.9)";
                ctx.beginPath();
                ctx.arc(hx, hy, w * 0.7, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
        // leads: the light crosses to the next part where it reaches a plugged jack
        for (const port of this.wiring.portsOf(id)) {
          const tp = a.t + (a.s === null ? 0 : arcDist(l, a.s, port.s) / SPEED);
          const k = 1 - (p.t - tp) / 0.3;
          if (k <= 0 || k > 1) continue;
          const ux = port.at[0] - port.toAt[0], uy = port.at[1] - port.toAt[1], n = Math.hypot(ux, uy) || 1, j = 4 / UNIT;
          const ja: [number, number] = [port.at[0] + (ux / n) * j, port.at[1] + (uy / n) * j], jb: [number, number] = [port.toAt[0] - (ux / n) * j, port.toAt[1] - (uy / n) * j];
          stroke([ja, jb], `rgba(57,211,83,${0.3 * k})`, w * 2.4);
          stroke([ja, jb], `rgba(176,237,186,${0.85 * k})`, w * 0.6);
          for (const q of [ja, jb]) {
            const [x, y] = toS(q);
            ctx.fillStyle = `rgba(57,211,83,${0.5 * k})`;
            ctx.beginPath();
            ctx.arc(x, y, (2 / UNIT) * cs * (1 + 0.5 * k), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  frame(now: number, interacting = false) {
    if (!interacting && now - this.last < 32) return; // idle animations at ~30 fps; gestures follow the display
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0.03;
    this.last = now;
    this.dt = dt;
    const snapshot = this.lowMotion ? [this.cam.x, this.cam.y, this.cam.z, this.hover, this.picked, this.me, this.selected,
      this.board.epoch, this.board.placedCount, this.stats.minted, this.stats.paid, this.reducedMotion,
      JSON.stringify(this.ghost), this.hints.length && this.hints.join(";"), [...this.board.drafts.values()].map(d => `${d.id}:${d.rot}:${d.x}:${d.y}:${d.ok}`).join("|")].join("/") : "";
    if (this.lowMotion && snapshot === this.snapshot && !this.needsFrame) {
      this.jackpot?.paint(this.reducedMotion);
      return;
    }
    this.snapshot = snapshot;
    if (!this.lowMotion) this.time += dt;
    for (const p of this.pulses) p.t += dt;
    this.pulses = this.lowMotion ? [] : this.pulses.filter((p) => p.t < PULSE_LIFETIME);
    this.alarm = Math.max(0, this.alarm - dt);
    if (this.lowMotion) { this.fresh.clear(); this.alarm = 0; }
    for (const [id, g] of this.fresh) g - dt * 0.6 <= 0 ? this.fresh.delete(id) : this.fresh.set(id, g - dt * 0.6);
    this.sprites.tick();

    const ctx = this.ctx;
    const r = this.canvas.getBoundingClientRect();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, r.width, r.height);
    this.grid(r.width, r.height);

    const [x0, y0] = this.unproject(-this.cs * 3, -this.cs * 3);
    const [x1, y1] = this.unproject(r.width + this.cs * 3, r.height + this.cs * 3);
    if (this.detailed && this.cs < DETAIL_OUT) this.detailed = false;
    else if (!this.detailed && this.cs >= DETAIL_IN) this.detailed = true;
    if (this.detailed) {
      // close up: every visible part, animated
      this.drawLayers(ctx, "core", CORE, 3, 3, 0, ...this.project(-1, -1), this.cs, this.dpr, this.time);
      for (const p of this.board.parts.values()) {
        if (!p.placed || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        this.part(p.id);
      }
    } else {
      // zoomed out: still tiles of 16 x 16 cells, rendered once, plus the marks that change
      this.tiles(r.width, r.height);
      for (const p of this.board.parts.values()) {
        if (!p.placed || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        if (this.fresh.has(p.id) || this.alarm > 0 || (this.me && p.owner.toLowerCase() === this.me.toLowerCase())) this.marks(p.id);
      }
    }
    this.signals();
    this.drawHints();
    for (const d of this.board.drafts.values()) this.part(-1, { design: d.design, rot: d.rot, x: d.x, y: d.y, ok: d.ok, draft: true, selected: d.id === this.selected });
    if (this.ghost) this.part(-1, this.ghost);
    this.hoverOutline(); // above all part art, signals and placement previews, before the CRT projection

    this.jackpot?.paint(this.reducedMotion); // DOM readout, independent of canvas performance mode
    this.curve.render(this.canvas);
    this.needsFrame = this.sprites.pending;
  }

  private grid(w: number, h: number) {
    const cs = this.cs;
    if (cs < 10) return;
    const ctx = this.ctx;
    ctx.fillStyle = "#262626";
    const [wx0, wy0] = this.unproject(0, 0);
    const [wx1, wy1] = this.unproject(w, h);
    for (let gx = Math.floor(wx0); gx <= wx1; gx++) {
      const [sx] = this.project(gx, 0);
      for (let gy = Math.floor(wy0); gy <= wy1; gy++) {
        const sy = (gy - this.cam.y) * cs + h / 2;
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
  }

  /** draw a part's layers onto `ctx` with its bounding box's top-left at (sx, sy), `cs` px per cell,
   *  after `rot` quarter turns. `dpr`: device pixels per px, to pick bitmaps sharp enough. Returns false if a
   *  bitmap wasn't ready yet. */
  private drawLayers(ctx: CanvasRenderingContext2D, id: string, layers: Layer[], w: number, h: number, rot: number, sx: number, sy: number, cs: number, dpr: number, t: number) {
    const k = cs / UNIT, px = k * dpr;
    const bw = rot % 2 ? h : w, bh = rot % 2 ? w : h;
    let complete = true;
    ctx.save();
    ctx.translate(sx + (bw * cs) / 2, sy + (bh * cs) / 2);
    ctx.rotate((rot * Math.PI) / 2);
    ctx.translate((-w * cs) / 2, (-h * cs) / 2);
    layers.forEach((l, i) => {
      if (l.live) return this.digits(ctx, l.live, k);
      const box = l.box ?? [0, 0, w * UNIT, h * UNIT];
      const bmp = this.sprites.get(`${id}:${i}`, box, px);
      if (!bmp) return void (complete = false);
      const a = l.anim;
      if (!a) return ctx.drawImage(bmp, box[0] * k, box[1] * k, box[2] * k, box[3] * k);
      ctx.save();
      if (l.clip) {
        ctx.beginPath();
        ctx.rect(l.clip[0] * k, l.clip[1] * k, l.clip[2] * k, l.clip[3] * k);
        ctx.clip();
      }
      if (a.fade) ctx.globalAlpha *= sample(a, t, a.fade);
      if (a.move) {
        const [mx, my] = sample(a, t, a.move);
        ctx.translate(mx * k, my * k);
      }
      if (a.rot) {
        const [cx, cy, v] = a.rot;
        ctx.translate(cx * k, cy * k);
        ctx.rotate((sample(a, t, v) * Math.PI) / 180);
        ctx.translate(-cx * k, -cy * k);
      }
      ctx.drawImage(bmp, box[0] * k, box[1] * k, box[2] * k, box[3] * k);
      ctx.restore();
    });
    ctx.restore();
    return complete;
  }

  /** a live display: lit seven-segment digits of a machine number */
  private digits(ctx: CanvasRenderingContext2D, lv: NonNullable<Layer["live"]>, k: number) {
    const v = Math.min(this.stats[lv.kind], 10 ** lv.n - 1);
    const str = String(Math.floor(v)).padStart(lv.n, "0");
    const X = Math.round(lv.x * 10), Y = Math.round(lv.y * 10), u = k / 10;
    ctx.fillStyle = LIT;
    for (let d = 0; d < lv.n; d++) {
      const m = DIGIT[+str[d]];
      SEG.forEach(([dx, dy, sw, sh], i) => (m >> i) & 1 && ctx.fillRect((X + d * 75 + dx) * u, (Y + dy) * u, sw * u, sh * u));
    }
  }

  part(id: number, ghost?: Ghost) {
    const ctx = this.ctx;
    const p = ghost ? { id: -1, design: ghost.design, rot: ghost.rot, x: ghost.x, y: ghost.y, owner: "" } : this.board.parts.get(id)!;
    const def = PARTS[p.design];
    if (!def) return;
    const cs = this.cs;
    const fp = ghost ? footprint(def.tmpl, p.rot, p.x, p.y) : this.board.fp.get(id) ?? footprint(def.tmpl, p.rot, p.x, p.y);
    const [bx, by] = bboxOf(fp);
    const energy = ghost ? 0 : this.energy(id);

    // each part keeps its own clock; a passing signal makes it run faster for a moment
    let clock = this.clocks.get(id) ?? id * 0.37;
    if (!ghost && !this.lowMotion) this.clocks.set(id, (clock += this.dt * (1 + 5 * energy)));

    if (ghost) ctx.globalAlpha = ghost.draft && ghost.ok ? 0.92 : 0.7;
    this.drawLayers(ctx, String(def.id), def.layers, def.w, def.h, p.rot, ...this.project(bx, by), cs, this.dpr, ghost ? this.time : clock);
    ctx.globalAlpha = 1;

    // live connections: the jacks of plugged-in sockets light up, and flare as a signal passes
    if (!ghost && cs >= 10) {
      const r = (1.6 / UNIT) * cs;
      for (const [lx, ly, dd] of this.board.links(id)) {
        const [jx, jy] = this.project(...jackAt(lx, ly, dd));
        if (energy > 0.05) {
          ctx.fillStyle = `rgba(176,237,186,${0.5 * energy})`;
          ctx.beginPath();
          ctx.arc(jx, jy, r * (1.6 + 1.6 * energy), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = energy > 0.5 ? "#b0edba" : LIT;
        ctx.beginPath();
        ctx.arc(jx, jy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (ghost?.draft) {
      if (!ghost.selected) ctx.setLineDash([Math.max(3, cs / 6), Math.max(2, cs / 10)]);
      this.border(fp, ghost.ok ? MINE : ALARM);
      ctx.setLineDash([]);
    } else if (ghost) this.border(fp, ghost.ok ? LIT : ALARM);
    else this.marks(id);
  }

  /** a part's frame in a colour (placing preview, just placed, celebrations) */
  private border(fp: number[][], color: string, weight = 1) {
    const ctx = this.ctx, cs = this.cs;
    {
      const inset = (2.5 / UNIT) * cs;
      ctx.lineWidth = Math.max(1.5, (2 / UNIT) * cs) * weight;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [fx, fy] of fp) {
        const [ex, ey] = this.project(fx, fy);
        const edges = DIRS.filter(([, vx, vy]) => !fp.some(([ox, oy]) => ox === fx + vx && oy === fy + vy));
        for (const [dd] of edges) {
          if (dd === 1) { ctx.moveTo(ex, ey + inset); ctx.lineTo(ex + cs, ey + inset); }
          if (dd === 4) { ctx.moveTo(ex, ey + cs - inset); ctx.lineTo(ex + cs, ey + cs - inset); }
          if (dd === 8) { ctx.moveTo(ex + inset, ey); ctx.lineTo(ex + inset, ey + cs); }
          if (dd === 2) { ctx.moveTo(ex + cs - inset, ey); ctx.lineTo(ex + cs - inset, ey + cs); }
        }
      }
      ctx.stroke();
    }

  }

  /** the width of a part's own ink border on screen (2 units of 40), never thinner than a pixel and a half */
  private inkWidth() {
    return Math.max(1.5, (2 / UNIT) * this.cs);
  }

  /** The outline of a part, any shape, on its own ink border (2.5 units inside its cells), in world coordinates, going
   *  round once. Cell edges with no neighbour in the part are joined into a polygon; every vertex then moves inward
   *  along both of its edges' normals, which keeps the corners square for rectilinear shapes. */
  private outline(fp: number[][]): [number, number][] {
    const has = (x: number, y: number) => fp.some(([ox, oy]) => ox === x && oy === y);
    // clockwise edges on screen (y down): the part lies to the right of each
    const next = new Map<string, [number, number, number, number]>();
    for (const [x, y] of fp) {
      if (!has(x, y - 1)) next.set(`${x},${y}`, [x, y, x + 1, y]);
      if (!has(x + 1, y)) next.set(`${x + 1},${y}`, [x + 1, y, x + 1, y + 1]);
      if (!has(x, y + 1)) next.set(`${x + 1},${y + 1}`, [x + 1, y + 1, x, y + 1]);
      if (!has(x - 1, y)) next.set(`${x},${y + 1}`, [x, y + 1, x, y]);
    }
    const [first] = next.values();
    const corners: [number, number, number, number][] = []; // vertex and the direction leaving it
    let e = first;
    do {
      const [x0, y0, x1, y1] = e;
      const d: [number, number] = [x1 - x0, y1 - y0];
      const last = corners[corners.length - 1];
      if (!last || last[2] !== d[0] || last[3] !== d[1]) corners.push([x0, y0, d[0], d[1]]);
      e = next.get(`${x1},${y1}`)!;
    } while (e !== first && e);
    if (corners.length > 1 && corners[0][2] === corners[corners.length - 1][2] && corners[0][3] === corners[corners.length - 1][3]) corners.shift();
    const inset = 2.5 / UNIT;
    return corners.map(([x, y, dx, dy], i) => {
      const [, , px, py] = corners[(i + corners.length - 1) % corners.length];
      // inward normal of a clockwise edge (dx, dy) is (-dy, dx)
      return [x + inset * (-dy - py), y + inset * (dx + px)];
    });
  }

  /** yours: short pieces of that outline at its corners, in your colour; they scale with the zoom */
  private mineMark(fp: number[][]) {
    const ctx = this.ctx, pts = this.outline(fp).map(([x, y]) => this.project(x, y)), n = pts.length;
    // short, thin and faint; they fade out as you zoom out, where a machine is mostly yours or nobody's
    const k = this.cs * 0.14, fade = Math.max(0, Math.min(1, (this.cs - 10) / 30));
    if (fade === 0) return;
    ctx.save();
    ctx.strokeStyle = `rgba(255,138,61,${(0.6 * fade).toFixed(3)})`;
    ctx.lineWidth = this.inkWidth() * 0.7; // under the hover and picked outline, which covers them
    ctx.lineJoin = "miter";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i], [ax, ay] = pts[(i + n - 1) % n], [bx, by] = pts[(i + 1) % n];
      const toward = (tx: number, ty: number) => {
        const len = Math.hypot(tx - x, ty - y) || 1, l = Math.min(k, len / 2);
        return [x + ((tx - x) / len) * l, y + ((ty - y) / len) * l] as const;
      };
      const [p0x, p0y] = toward(ax, ay), [p1x, p1y] = toward(bx, by);
      ctx.moveTo(p0x, p0y); ctx.lineTo(x, y); ctx.lineTo(p1x, p1y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** keep the tile index in step with the board; a newly placed part drops the tiles it touches */
  private indexTiles() {
    if (this.tileEpoch !== this.board.epoch) {
      // a new machine: drop everything cached for the old one
      this.tileEpoch = this.board.epoch;
      this.tileIndexed.clear();
      this.tileParts.clear();
      this.tileBitmaps.clear();
      this.fresh.clear();
    }
    if (this.tileIndexed.size === this.board.placedCount) return;
    for (const p of this.board.parts.values()) {
      if (!p.placed || this.tileIndexed.has(p.id)) continue;
      this.tileIndexed.add(p.id);
      const fp = this.board.fp.get(p.id);
      if (!fp) continue;
      const [bx, by, bw, bh] = bboxOf(fp);
      for (let tx = Math.floor(bx / TILE); tx <= Math.floor((bx + bw - 1) / TILE); tx++)
        for (let ty = Math.floor(by / TILE); ty <= Math.floor((by + bh - 1) / TILE); ty++) {
          const k = `${tx},${ty}`;
          const list = this.tileParts.get(k) ?? [];
          list.push(p.id);
          this.tileParts.set(k, list);
        }
      // the part, and the neighbours whose jacks it lights, may sit in any tile within a cell of it
      for (let tx = Math.floor((bx - 1) / TILE); tx <= Math.floor((bx + bw) / TILE); tx++)
        for (let ty = Math.floor((by - 1) / TILE); ty <= Math.floor((by + bh) / TILE); ty++) this.tileBitmaps.delete(`${tx},${ty}`);
    }
  }

  /** draw the visible tiles, rendering missing ones (a few per frame) at a scale bucket of the zoom */
  private tiles(w: number, h: number) {
    this.indexTiles();
    const cs = this.cs;
    const scale = 2 ** (Math.round(Math.log2(cs * this.dpr) * 2) / 2); // device px per cell, in half-octave steps
    if (scale !== this.tileScale) {
      this.tileScale = scale;
      this.tileBitmaps.clear();
    }
    const [wx0, wy0] = this.unproject(0, 0), [wx1, wy1] = this.unproject(w, h);
    let budget = TILE_RENDERS;
    for (let tx = Math.floor(wx0 / TILE); tx <= Math.floor(wx1 / TILE); tx++)
      for (let ty = Math.floor(wy0 / TILE); ty <= Math.floor(wy1 / TILE); ty++) {
        const k = `${tx},${ty}`;
        const ids = this.tileParts.get(k);
        if (!ids && !((tx === 0 || tx === -1) && (ty === 0 || ty === -1))) continue; // the core spans tiles -1 and 0
        let bmp = this.tileBitmaps.get(k);
        if (!bmp && budget-- > 0) bmp = this.renderTile(tx, ty, ids ?? [], scale) ?? undefined;
        if (!bmp) { this.sprites.pending = true; continue; }
        // snap to whole pixels and overlap by one, so no seams show between tiles
        const [sx, sy] = this.project(tx * TILE, ty * TILE), [ex, ey] = this.project((tx + 1) * TILE, (ty + 1) * TILE);
        const x = Math.floor(sx), y = Math.floor(sy);
        this.ctx.drawImage(bmp, x, y, Math.ceil(ex) - x + 1, Math.ceil(ey) - y + 1);
      }
  }

  private renderTile(tx: number, ty: number, ids: number[], scale: number): HTMLCanvasElement | null {
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(TILE * scale);
    const g = c.getContext("2d")!;
    const ox = tx * TILE, oy = ty * TILE;
    let complete = true;
    if ((tx === 0 || tx === -1) && (ty === 0 || ty === -1)) complete = this.drawLayers(g, "core", CORE, 3, 3, 0, (-1 - ox) * scale, (-1 - oy) * scale, scale, 1, 0) && complete;
    for (const id of ids) {
      const p = this.board.parts.get(id)!;
      const def = PARTS[p.design];
      const fp = this.board.fp.get(id);
      if (!def || !fp) continue;
      const [bx, by] = bboxOf(fp);
      complete = this.drawLayers(g, String(def.id), def.layers, def.w, def.h, p.rot, (bx - ox) * scale, (by - oy) * scale, scale, 1, 0) && complete;
      g.fillStyle = LIT;
      for (const [lx, ly, dd] of this.board.links(id)) {
        const [jx, jy] = jackAt(lx, ly, dd);
        g.beginPath();
        g.arc((jx - ox) * scale, (jy - oy) * scale, (1.6 / UNIT) * scale, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (complete) this.tileBitmaps.set(`${tx},${ty}`, c);
    return c;
  }

  /** what changes on a placed part outside its art: the flash when paid or placed, your marks */
  private marks(id: number) {
    const p = this.board.parts.get(id)!;
    const fp = this.board.fp.get(id);
    if (!fp) return;
    const alarm = this.alarm > 0 && Math.floor(this.alarm * 6) % 2 === 0 ? 1 : 0;
    const lit = Math.max(this.fresh.get(id) ?? 0, alarm);
    if (lit > 0.05) this.border(fp, `rgba(57,211,83,${0.35 + 0.65 * lit})`);
    if (this.me && p.owner?.toLowerCase() === this.me.toLowerCase()) {
      this.mineMark(fp);
    }
  }

  /** where the picked part fits: a phosphor square in each empty cell it can plug into, blinking in steps */
  private drawHints() {
    if (!this.hints.length) return;
    const ctx = this.ctx, cs = this.cs;
    const on = this.lowMotion || Math.floor(this.time * 1.6) % 2 === 0;
    const pad = Math.max(1, cs * 0.14);
    ctx.save();
    ctx.fillStyle = on ? "rgba(57,211,83,0.22)" : "rgba(57,211,83,0.1)";
    ctx.strokeStyle = on ? LIT : "rgba(57,211,83,0.55)";
    ctx.lineWidth = Math.max(1, Math.min(2, cs / 20));
    for (const [x, y] of this.hints) {
      const [sx, sy] = this.project(x, y);
      ctx.fillRect(sx + pad, sy + pad, cs - 2 * pad, cs - 2 * pad);
      if (cs >= 8) ctx.strokeRect(sx + pad, sy + pad, cs - 2 * pad, cs - 2 * pad);
    }
    ctx.restore();
  }

  private hoverOutline() {
    // the picked part: the frame in its rarity colour; the hovered part: the same frame in white. Drawn after the parts,
    // so it covers your corner marks exactly (they are pieces of this frame)
    const frame = (id: number, width: number) => {
      const fp = id === 0 ? CORE_CELLS : this.board.fp.get(id);
      if (!fp) return;
      const ctx = this.ctx, pts = this.outline(fp).map(([x, y]) => this.project(x, y));
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = width;
      ctx.lineJoin = "miter";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    // both white, on the part's own border: picked a little heavier than hover
    const ink = this.inkWidth();
    if (this.picked !== null) frame(this.picked, ink * 1.6);
    if (this.hover !== null && this.hover !== this.picked) frame(this.hover, ink);
  }
}

/** an animated picture of a part (shelf, tooltips, parts page): the same SVG the chain serves */
export function partImage(design: number, size: number, animate = true): HTMLImageElement {
  const img = new Image();
  const svg = animate ? PARTS[design].svg : PARTS[design].svg.replace(/<animate(?:Transform)?\b[^>]*\/>/g, "");
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  img.width = size;
  img.height = size;
  img.style.objectFit = "contain";
  img.alt = PARTS[design].name;
  img.draggable = false;
  return img;
}
