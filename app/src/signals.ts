// Signals through the wiring. Light runs around each module's border (the IMD wall's lit frame) and jumps to the
// next module wherever two jacks are plugged together. Arrival times come from a shortest-path search over the
// plugged sockets, so a signal really follows the wiring: it goes round a part to reach its other jacks.
import { Board, footprint, key, DIRS, opp } from "./geometry";
import { PARTS, UNIT, CORE_CELLS } from "./parts.gen";

const INSET = 2.5 / UNIT; // the module border's inset from the cell edges, in cells
export const SPEED = 7; // cells per second along a border
export const PULSE_LIFETIME = 2.4; // power runs out before distant nodes are reached
export const pulsePower = (t: number) => Math.max(0, 1 - t / PULSE_LIFETIME) ** 2;
const LEAD = 0.05; // seconds to cross a cable lead between two parts

type Pt = [number, number];

/** a module's border: a closed polyline (clockwise) with cumulative lengths */
export interface Loop {
  pts: Pt[];
  cum: number[];
  len: number;
}

/** a plugged socket: where it meets this part's border (s) and the neighbour's (toS) */
interface Port {
  s: number;
  at: Pt; // the border point on this part
  to: number;
  toS: number;
  toAt: Pt;
}

export interface Arrival {
  t: number; // seconds after the pulse starts
  s: number | null; // where the light enters the border; null = the source part, which lights all at once
}

/** the outline of a union of unit cells, inset by INSET, clockwise in y-down coordinates */
function outline(cells: Pt[]): Loop {
  const has = new Set(cells.map(([x, y]) => key(x, y)));
  const next = new Map<string, Pt>();
  for (const [x, y] of cells) {
    if (!has.has(key(x, y - 1))) next.set(key(x, y), [x + 1, y]);
    if (!has.has(key(x + 1, y))) next.set(key(x + 1, y), [x + 1, y + 1]);
    if (!has.has(key(x, y + 1))) next.set(key(x + 1, y + 1), [x, y + 1]);
    if (!has.has(key(x - 1, y))) next.set(key(x, y + 1), [x, y]);
  }
  // walk the boundary, keeping only corners
  const start = [...next.keys()][0].split(",").map(Number) as Pt;
  const raw: Pt[] = [start];
  let p = next.get(key(...start))!;
  while (key(...p) !== key(...start)) {
    raw.push(p);
    p = next.get(key(...p))!;
  }
  const corners = raw.filter((v, i) => {
    const a = raw[(i + raw.length - 1) % raw.length], b = raw[(i + 1) % raw.length];
    return (v[0] - a[0]) * (b[1] - v[1]) - (v[1] - a[1]) * (b[0] - v[0]) !== 0;
  });
  // move each corner inward along both edge normals (the right-hand normal points inside)
  const pts = corners.map((v, i) => {
    const a = corners[(i + corners.length - 1) % corners.length], b = corners[(i + 1) % corners.length];
    const d1 = [Math.sign(v[0] - a[0]), Math.sign(v[1] - a[1])], d2 = [Math.sign(b[0] - v[0]), Math.sign(b[1] - v[1])];
    return [v[0] + INSET * (-d1[1] - d2[1]), v[1] + INSET * (d1[0] + d2[0])] as Pt;
  });
  const cum = [0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, len: cum[pts.length] };
}

/** the arc position of a point that lies on the loop */
function project(l: Loop, q: Pt): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < l.pts.length; i++) {
    const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
    const d = Math.hypot(a[0] + u * dx - q[0], a[1] + u * dy - q[1]);
    if (d < bestD) (bestD = d), (best = l.cum[i] + u * Math.sqrt(L2));
  }
  return best;
}

export function pointAt(l: Loop, s: number): Pt {
  s = ((s % l.len) + l.len) % l.len;
  let i = 0;
  while (i < l.pts.length - 1 && l.cum[i + 1] <= s) i++;
  const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
  const u = (s - l.cum[i]) / (l.cum[i + 1] - l.cum[i] || 1);
  return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
}

/** the points of the loop from arc position a to b (a < b, may run past the end) */
export function arcPoints(l: Loop, a: number, b: number): Pt[] {
  const out: Pt[] = [pointAt(l, a)];
  const n = l.pts.length;
  const base = Math.floor(a / l.len) * l.len;
  for (let k = 0; k < 3 * n; k++) {
    const turn = Math.floor(k / n), i = k % n;
    const s = base + turn * l.len + l.cum[i];
    if (s > a && s < b) out.push(l.pts[i]);
  }
  out.push(pointAt(l, b));
  return out;
}

const arcDist = (l: Loop, a: number, b: number) => {
  const d = Math.abs(a - b) % l.len;
  return Math.min(d, l.len - d);
};

export class Wiring {
  loops = new Map<number, Loop>();
  ports = new Map<number, Port[]>();
  private at = "";

  constructor(private board: Board) {}

  private cellsOf(id: number): Pt[] {
    if (id === 0) return CORE_CELLS.map(([x, y]) => [x, y] as Pt);
    const p = this.board.parts.get(id)!;
    return footprint(PARTS[p.design].tmpl, p.rot, p.x, p.y).map(([x, y]) => [x, y] as Pt);
  }

  /** rebuild loops and ports when the machine has changed */
  sync() {
    const at = `${this.board.epoch}:${this.board.placedCount}`;
    if (this.at === at) return;
    this.at = at;
    this.loops.clear();
    this.ports.clear();
    const ids = [0, ...[...this.board.parts.values()].filter((p) => p.placed).map((p) => p.id)];
    for (const id of ids) this.loops.set(id, outline(this.cellsOf(id)));
    // a socket meets the border at its cell edge's midpoint, moved in by the inset
    const edgePoint = (x: number, y: number, d: number): Pt =>
      d === 1 ? [x + 0.5, y + INSET] : d === 2 ? [x + 1 - INSET, y + 0.5] : d === 4 ? [x + 0.5, y + 1 - INSET] : [x + INSET, y + 0.5];
    for (const [k, c] of this.board.cells) {
      const [x, y] = k.split(",").map(Number);
      for (const [d, vx, vy] of DIRS) {
        if (!(c.mask & d)) continue;
        const nb = this.board.cells.get(key(x + vx, y + vy));
        if (!nb || nb.id === c.id || !(nb.mask & opp(d))) continue;
        const l = this.loops.get(c.id), nl = this.loops.get(nb.id);
        if (!l || !nl) continue;
        const at = edgePoint(x, y, d), toAt = edgePoint(x + vx, y + vy, opp(d));
        const list = this.ports.get(c.id) ?? [];
        list.push({ s: project(l, at), at, to: nb.id, toS: project(nl, toAt), toAt });
        this.ports.set(c.id, list);
      }
    }
  }

  /** when (and where) a signal reaches nearby parts before its power runs out */
  arrivals(src: number, maxTime = PULSE_LIFETIME): Map<number, Arrival> {
    this.sync();
    if (!this.loops.has(src)) return new Map();
    const best = new Map<number, Arrival>([[src, { t: 0, s: null }]]);
    const queue = new Heap();
    queue.push(0, src);
    const done = new Set<number>();
    while (queue.size) {
      const [t, id] = queue.pop();
      if (done.has(id)) continue;
      done.add(id);
      const here = best.get(id)!;
      const l = this.loops.get(id)!;
      for (const p of this.ports.get(id) ?? []) {
        const out = t + (here.s === null ? 0 : arcDist(l, here.s, p.s) / SPEED) + LEAD;
        if (out >= maxTime) continue;
        const cur = best.get(p.to);
        if (!cur || out < cur.t) {
          best.set(p.to, { t: out, s: p.toS });
          queue.push(out, p.to);
        }
      }
    }
    return best;
  }

  /** the plugged sockets of a part, with the time the signal crosses each (for flashing jacks and leads) */
  portsOf(id: number) {
    return this.ports.get(id) ?? [];
  }
}

export { arcDist };

/** a binary min-heap of (time, part) for the shortest-path search */
class Heap {
  private t: number[] = [];
  private v: number[] = [];
  get size() {
    return this.t.length;
  }
  push(t: number, v: number) {
    const a = this.t, b = this.v;
    let i = a.length;
    a.push(t);
    b.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [b[p], b[i]] = [b[i], b[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.t, b = this.v;
    const top: [number, number] = [a[0], b[0]];
    const lt = a.pop()!, lv = b.pop()!;
    if (a.length) {
      a[0] = lt;
      b[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [b[m], b[i]] = [b[i], b[m]];
        i = m;
      }
    }
    return top;
  }
}
