// Mirrors src/Shapes.sol and IdentityMachine placement rules. The part catalog comes from art/parts.mjs.
import { PARTS, UNIT, TEMPLATES as GEN_TEMPLATES, CORE_CELLS } from "./parts.gen.ts";

export const N = 1, E = 2, S = 4, W = 8;
export const MAX_DRAFT_PARTS = 50;
export const BOUND = 100_000;
export interface GrowthExit { x: number; y: number; direction: number }
export const DIRS: [number, number, number][] = [[N, 0, -1], [E, 1, 0], [S, 0, 1], [W, -1, 0]];
export const opp = (d: number) => (d === N ? S : d === S ? N : d === E ? W : E);

export const TIER_NAME = ["Common", "Uncommon", "Rare", "Legendary", "Agent Core"];
export const TIER_CLASS = ["common", "uncommon", "rare", "legendary", "seat"];
export const TIER_WEIGHT = [1, 2, 5, 20, 1];
/** IdentityMachine.rollTier odds, out of 10,000 */
export const TIER_ODDS = [7000, 2200, 700, 100, 0];
export const AGENT_CORE = PARTS.findIndex((p) => p.tier === 4);

export const T = { STRAIGHT: 0, CORNER: 1, TEE: 2, CROSS: 3, CAP: 4, LONG: 5, MANIFOLD: 6, BAR3: 7, ELL: 8, HUB: 9, BIGHUB: 10, REACTOR: 11 };
export const TEMPLATE_NAME = ["Straight", "Corner", "Tee", "Cross", "Cap", "Long", "Manifold", "Bar", "Ell", "Hub", "Big hub", "Reactor"];

type Cell = [number, number, number]; // dx, dy, sockets
/** cells of each template in rotation 0, generated with the art (art/parts.mjs) and tested against Shapes.sol */
export const TEMPLATES: Cell[][] = GEN_TEMPLATES;

/** Shapes.dropOdds: per-mille odds of each template within a tier, the same for every mint */
export const DROPS: Record<number, Record<number, number>> = {
  0: { 0: 220, 1: 220, 2: 200, 3: 80, 4: 100, 5: 180 },
  1: { 1: 150, 2: 200, 3: 150, 5: 200, 6: 300 },
  2: { 3: 200, 7: 250, 8: 250, 9: 300 },
  3: { 10: 700, 11: 300 },
  4: { 3: 1000 },
};
/** per-mille odds of template `t` within `tier` */
export const dropOdds = (tier: number, t: number) => DROPS[tier]?.[t] ?? 0;
/** which templates exist in each tier */
export const SLOTS: Record<number, number[]> = Object.fromEntries(Object.entries(DROPS).map(([k, v]) => [k, Object.keys(v).map(Number)]));

export const rotMask = (m: number, r: number) => {
  for (let i = 0; i < r; i++) m = ((m << 1) | (m >> 3)) & 15;
  return m;
};

export function footprint(tmpl: number, rot: number, x: number, y: number): Cell[] {
  return TEMPLATES[tmpl].map(([dx, dy, m]) => {
    let rx = dx, ry = dy;
    for (let i = 0; i < rot; i++) [rx, ry] = [-ry, rx];
    return [x + rx, y + ry, rotMask(m, rot)] as Cell;
  });
}

export function bbox(tmpl: number) {
  const c = TEMPLATES[tmpl];
  return { w: Math.max(...c.map((v) => v[0])) + 1, h: Math.max(...c.map((v) => v[1])) + 1 };
}

export const key = (x: number, y: number) => `${x},${y}`;

export interface DesignInfo {
  id: number;
  name: string;
  tier: number;
  tmpl: number;
  about: string;
}

/** chance that a mint reveals this part (Agent Cores are claimed, never minted) */
export const oddsOf = (d: DesignInfo) =>
  (TIER_ODDS[d.tier] / 10_000) * (dropOdds(d.tier, d.tmpl) / 1000) / PARTS.filter((p) => p.tier === d.tier && p.tmpl === d.tmpl).length;

/** where a socket's jack sits in world units: 6.5/40 in from the cell edge */
export function jackAt(cx: number, cy: number, d: number): [number, number] {
  const k = 6.5 / UNIT;
  if (d === N) return [cx + 0.5, cy + k];
  if (d === E) return [cx + 1 - k, cy + 0.5];
  if (d === S) return [cx + 0.5, cy + 1 - k];
  return [cx + k, cy + 0.5];
}

export interface PartState {
  id: number;
  design: number;
  designKnown?: boolean;
  rot: number;
  x: number;
  y: number;
  placed: boolean;
  owner: string; // inventory: the item's recipient; placed: whoever placed it (its earnings are theirs)
  place?: number; // prize place 1 .. 10 when its round ended
  seat?: number;
  plug?: bigint; // plug-pay it carries until placed
}

export interface Draft {
  id: number;
  design: number;
  rot: number;
  x: number;
  y: number;
  px: number; // pivot: where it was dropped, in world units
  py: number;
  fp: Cell[];
  ok: boolean; // fits right now
  reason: "" | "occupied" | "mismatch" | "unplugged" | "bounds";
}

export type FitResult = { ok: true; links: number } | { ok: false; reason: "occupied" | "mismatch" | "unplugged" | "bounds" };

export class Board {
  cells = new Map<string, { id: number; mask: number }>();
  parts = new Map<number, PartState>();
  designs = new Map<number, DesignInfo>(PARTS.map((p) => [p.id, { id: p.id, name: p.name, tier: p.tier, tmpl: p.tmpl, about: p.about }]));
  placedCount = 0;
  /** the machine shown: bumped when a round ends and a new machine opens (caches keyed on the board reset) */
  epoch = 0;
  round = 0;

  constructor() {
    for (const [x, y, m] of CORE_CELLS) this.cells.set(key(x, y), { id: 0, mask: m });
  }

  /** a new machine: an empty field around the core; parts in inventories stay, placed ones leave with the old one */
  reset(round: number) {
    this.round = round;
    this.epoch++;
    this.cells.clear();
    for (const [x, y, m] of CORE_CELLS) this.cells.set(key(x, y), { id: 0, mask: m });
    for (const [id, p] of this.parts) if (p.placed) this.parts.delete(id);
    this.fp.clear();
    this.placedCount = 0;
    this.linkCache.clear();
    this.linksAt = -1;
    this.relay();
  }

  tmplOf(designId: number) {
    return this.designs.get(designId)?.tmpl ?? 0;
  }

  upsert(p: Partial<PartState> & { id: number }) {
    const cur = this.parts.get(p.id) ?? { id: p.id, design: 0, designKnown: false, rot: 0, x: 0, y: 0, placed: false, owner: "" };
    Object.assign(cur, p);
    if (p.design !== undefined) cur.designKnown = true;
    this.parts.set(p.id, cur);
    return cur;
  }

  /** each placed part's cells, worked out once */
  fp = new Map<number, Cell[]>();
  private linkCache = new Map<number, [number, number, number][]>();
  private linksAt = -1;

  place(id: number, rot: number, x: number, y: number) {
    const p = this.upsert({ id, rot, x, y, placed: true });
    const cells = footprint(this.tmplOf(p.design), rot, x, y);
    this.fp.set(id, cells);
    for (const [cx, cy, m] of cells) this.cells.set(key(cx, cy), { id, mask: m });
    this.placedCount++;
  }

  // ---- drafts: parts arranged on the board but not sent yet. A draft can sit anywhere, fitting or not; the ones
  // that fit count when fitting later ones (so a draft can plug into an earlier draft). Install sends the whole
  // fitting draft, up to 50 parts. Ids: a part id, or -mintId for a mint that the build will reveal. Each draft turns around a fixed
  // pivot (where it was dropped), so four quarter turns bring it back exactly.
  drafts = new Map<number, Draft>();
  draftLimit = MAX_DRAFT_PARTS;
  get draftFull() { return this.drafts.size >= this.draftLimit; }
  canDraft(id: number) { return this.drafts.has(id) || !this.draftFull; }
  private draftCells = new Map<string, { id: number; mask: number }>();

  cellAt(k: string) {
    return this.cells.get(k) ?? this.draftCells.get(k);
  }

  /** a draft's cell position for rotation `rot`, centred on its pivot */
  private at(design: number, rot: number, px: number, py: number) {
    const { w, h } = bbox(this.tmplOf(design));
    const [ww, hh] = rot % 2 ? [h, w] : [w, h];
    return { x: Math.round(px - ww / 2), y: Math.round(py - hh / 2) };
  }

  /** put a draft down (or move it) with its middle at world point (px, py) */
  setDraft(id: number, design: number, rot: number, px: number, py: number) {
    if (!this.canDraft(id)) return false;
    const { x, y } = this.at(design, rot, px, py);
    this.drafts.set(id, { id, design, rot, x, y, px, py, fp: footprint(this.tmplOf(design), rot, x, y), ok: false, reason: "" });
    this.relay();
    return true;
  }

  /** a quarter turn clockwise around its pivot, whether or not it fits there */
  rotateDraft(id: number) {
    const d = this.drafts.get(id);
    if (d) this.setDraft(id, d.design, (d.rot + 1) % 4, d.px, d.py);
  }

  /** take drafts off (all if no id) */
  removeDraft(id?: number) {
    if (id === undefined) this.drafts.clear();
    else this.drafts.delete(id);
    this.relay();
  }

  /**
   * Check every draft in order against the machine and the fitting drafts before it. Call after the machine
   * changes. Returns the drafts that fitted before and don't now (someone took the spot).
   */
  relay(): number[] {
    const was = new Set([...this.drafts.values()].filter((d) => d.ok).map((d) => d.id));
    this.draftCells.clear();
    const lost: number[] = [];
    for (const d of this.drafts.values()) {
      const f = this.fit(this.tmplOf(d.design), d.rot, d.x, d.y);
      d.ok = f.ok;
      d.reason = f.ok ? "" : f.reason;
      if (f.ok) for (const [cx, cy, m] of d.fp) this.draftCells.set(key(cx, cy), { id: d.id, mask: m });
      else if (was.has(d.id)) lost.push(d.id);
    }
    return lost;
  }

  /** a drafted mint was revealed (by anyone): it is now part `partId` */
  rekeyDraft(from: number, to: number) {
    if (!this.drafts.has(from)) return;
    const list = [...this.drafts.values()].map((x) => (x.id === from ? { ...x, id: to } : x));
    this.drafts = new Map(list.map((x) => [x.id, x]));
    this.relay();
  }

  /** for one-click placement: a draft at a spot known to fit */
  addDraft(id: number, design: number, rot: number, x: number, y: number) {
    const { w, h } = bbox(this.tmplOf(design));
    const [ww, hh] = rot % 2 ? [h, w] : [w, h];
    return this.setDraft(id, design, rot, x + ww / 2, y + hh / 2);
  }

  socketCount(id: number) {
    let n = 0;
    for (const [, , m] of this.fp.get(id) ?? []) for (const [d] of DIRS) if (m & d) n++;
    return n;
  }

  /** sockets of a placed part that still face an empty cell */
  openCount(id: number) {
    let n = 0;
    for (const [cx, cy, m] of this.fp.get(id) ?? []) for (const [d, vx, vy] of DIRS) if (m & d && !this.cellAt(key(cx + vx, cy + vy))) n++;
    return n;
  }

  /** IdentityMachine._check, client side */
  fit(tmpl: number, rot: number, x: number, y: number): FitResult {
    const fp = footprint(tmpl, rot, x, y);
    const mine = new Set(fp.map(([cx, cy]) => key(cx, cy)));
    for (const [cx, cy] of fp) if (Math.abs(cx) > BOUND || Math.abs(cy) > BOUND) return { ok: false, reason: "bounds" };
    for (const [cx, cy] of fp) if (this.cellAt(key(cx, cy))) return { ok: false, reason: "occupied" };
    let links = 0;
    for (const [cx, cy, m] of fp) {
      for (const [d, vx, vy] of DIRS) {
        const k = key(cx + vx, cy + vy);
        if (mine.has(k)) continue;
        const nb = this.cellAt(k);
        if (!nb) continue;
        const a = !!(m & d), b = !!(nb.mask & opp(d));
        if (a !== b) return { ok: false, reason: "mismatch" };
        if (a) links++;
      }
    }
    if (links === 0) return { ok: false, reason: "unplugged" };
    return { ok: true, links };
  }

  /** the parts a placement's plug-pay would go to, one entry per plugged socket (0 = the core: the pot) */
  payees(tmpl: number, rot: number, x: number, y: number): number[] {
    const fp = footprint(tmpl, rot, x, y);
    const mine = new Set(fp.map(([cx, cy]) => key(cx, cy)));
    const out: number[] = [];
    for (const [cx, cy, m] of fp) for (const [d, vx, vy] of DIRS) {
      const k = key(cx + vx, cy + vy);
      if (mine.has(k) || !(m & d)) continue;
      const nb = this.cellAt(k);
      if (nb && nb.mask & opp(d)) out.push(nb.id);
    }
    return out;
  }

  /** best rotation at (x,y), preferring `rot` */
  bestFit(tmpl: number, rot: number, x: number, y: number) {
    let first: FitResult | null = null;
    for (let i = 0; i < 4; i++) {
      const r = (rot + i) % 4;
      const f = this.fit(tmpl, r, x, y);
      if (f.ok) return { rot: r, fit: f };
      if (!first) first = f;
    }
    return { rot, fit: first! };
  }

  /** open sockets: (cell, direction) pairs facing an empty cell */
  openSockets(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (const map of [this.cells, this.draftCells])
      for (const [k, c] of map) {
        const [x, y] = k.split(",").map(Number);
        for (const [d, vx, vy] of DIRS) if (c.mask & d && !this.cellAt(key(x + vx, y + vy))) out.push([x, y, d]);
      }
    return out;
  }

  /** Final-state witness for the whole draft; checking this is automatic and never changes individual fit rules. */
  growthExit(extra?: Cell[]): GrowthExit | null {
    const cells: Cell[] = [];
    for (const [k, c] of this.cells) {
      const [x, y] = k.split(",").map(Number);
      cells.push([x, y, c.mask]);
    }
    if (extra) cells.push(...extra);
    else for (const [k, c] of this.draftCells) {
      const [x, y] = k.split(",").map(Number);
      cells.push([x, y, c.mask]);
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of cells) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    for (const [x, y, mask] of cells) {
      if (y === minY && y > -BOUND && mask & N) return { x, y, direction: N };
      if (x === maxX && x < BOUND && mask & E) return { x, y, direction: E };
      if (y === maxY && y < BOUND && mask & S) return { x, y, direction: S };
      if (x === minX && x > -BOUND && mask & W) return { x, y, direction: W };
    }
    return null;
  }

  /**
   * Every spot where a part of `tmpl` plugs in right now, for showing where a picked part fits and snapping to it.
   * (cx, cy): the empty cell it plugs into; (mx, my): the middle of its footprint. `ignore`: a draft being moved,
   * left out so it doesn't block its own spots. The whole-draft growth rule is checked at Install, not here.
   */
  fitSpots(tmpl: number, ignore?: number, limit = 800) {
    const hidden: [string, { id: number; mask: number }][] = [];
    if (ignore !== undefined) for (const [k, c] of this.draftCells) if (c.id === ignore) hidden.push([k, c]);
    for (const [k] of hidden) this.draftCells.delete(k);
    const out: { rot: number; x: number; y: number; cx: number; cy: number; mx: number; my: number }[] = [];
    const seen = new Set<string>();
    const { w, h } = bbox(tmpl);
    try {
      for (const [sx, sy, d] of this.openSockets()) {
        const [, vx, vy] = DIRS.find((v) => v[0] === d)!;
        const tx = sx + vx, ty = sy + vy;
        for (let rot = 0; rot < 4; rot++) {
          for (const [cx, cy, m] of footprint(tmpl, rot, 0, 0)) {
            if (!(m & opp(d))) continue;
            const x = tx - cx, y = ty - cy, k = `${rot},${x},${y}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const [ww, hh] = rot % 2 ? [h, w] : [w, h];
            if (this.fit(tmpl, rot, x, y).ok) out.push({ rot, x, y, cx: tx, cy: ty, mx: x + ww / 2, my: y + hh / 2 });
          }
        }
        if (out.length >= limit) break;
      }
    } finally {
      for (const [k, c] of hidden) this.draftCells.set(k, c);
    }
    return out;
  }

  /** a legal spot for one-click placement: plug into the open socket closest to the core */
  autoSpot(tmpl: number): { rot: number; x: number; y: number } | null {
    const socks = this.openSockets().sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) + (Math.random() - 0.5) * 3);
    for (const [sx, sy, d] of socks.slice(0, 200)) {
      const tx = sx + DIRS.find((v) => v[0] === d)![1], ty = sy + DIRS.find((v) => v[0] === d)![2];
      for (let rot = 0; rot < 4; rot++) {
        for (const [cx, cy, m] of footprint(tmpl, rot, 0, 0)) {
          if (!(m & opp(d))) continue;
          const x = tx - cx, y = ty - cy;
          const fp = footprint(tmpl, rot, x, y);
          if (this.fit(tmpl, rot, x, y).ok && this.growthExit([...this.drafts.values()].filter(d => d.ok).flatMap(d => d.fp).concat(fp))) return { rot, x, y };
        }
      }
    }
    return null;
  }

  /** which sockets of a placed part are plugged into a neighbour (cached until the machine changes) */
  links(id: number): [number, number, number][] {
    if (this.linksAt !== this.placedCount) {
      this.linkCache.clear();
      this.linksAt = this.placedCount;
    }
    if (id === 0) return [];
    let out = this.linkCache.get(id);
    if (out) return out;
    out = [];
    this.linkCache.set(id, out);
    for (const [cx, cy, m] of this.fp.get(id) ?? []) {
      for (const [d, vx, vy] of DIRS) {
        if (!(m & d)) continue;
        const nb = this.cells.get(key(cx + vx, cy + vy));
        if (nb && nb.id !== id && nb.mask & opp(d)) out.push([cx, cy, d]);
      }
    }
    return out;
  }
}
