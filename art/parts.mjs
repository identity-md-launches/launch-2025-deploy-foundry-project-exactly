#!/usr/bin/env node
// Identity Machine parts: hand-made vector SVG. This file is the single source of every part's art.
//
//   node art/parts.mjs
//
// writes
//   src/art/Catalog.sol    the fixed catalog: rarity and template of every part
//   app/src/parts.gen.ts             the same parts as layers for the canvas (static layers + moving layers)
//   art/out/<id>.svg                 every part's full animated SVG
//   art/preview.html                 every part, animated
//
// Units: one grid cell is 40 × 40. A part is drawn at rotation 0 inside its template's bounding box.
// Sockets sit at the middle of a cell edge. Moving layers carry one animation, which the generator turns
// into SMIL for the chain and into a small keyframe spec the canvas plays back.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = 40;
const N = 1, E = 2, S = 4, W = 8;

// must match src/Shapes.sol
const TEMPLATES = [
  [[0, 0, E | W]],
  [[0, 0, E | S]],
  [[0, 0, E | W | S]],
  [[0, 0, 15]],
  [[0, 0, S]],
  [[0, 0, W], [1, 0, E]],
  [[0, 0, W | S], [1, 0, E | S]],
  [[0, 0, W], [1, 0, N | S], [2, 0, E]],
  [[0, 0, N | W], [1, 0, E], [1, 1, S]],
  [[0, 0, N | W], [1, 0, E], [1, 1, S], [0, 1, W]],
  [[0, 0, N | W], [1, 0, E], [1, 1, E | S], [0, 1, W]],
  [[0, 0, N], [1, 0, N], [2, 0, E], [0, 1, W], [1, 1, 0], [2, 1, E], [0, 2, W], [1, 2, S], [2, 2, S]],
];
const T = { STRAIGHT: 0, CORNER: 1, TEE: 2, CROSS: 3, CAP: 4, LONG: 5, MANIFOLD: 6, BAR3: 7, ELL: 8, HUB: 9, BIGHUB: 10, REACTOR: 11 };
/** the v6 core: 3 x 3, a socket on every outer edge (twelve); IdentityMachine._cell. Drawn by the app, not a token. */
const CORE_CELLS = [[0, 0, N | W], [1, 0, N], [2, 0, N | E], [0, 1, W], [1, 1, 0], [2, 1, E], [0, 2, S | W], [1, 2, S], [2, 2, S | E]];
/** a template id, or an explicit cell list (the core) */
const tcells = (t) => (Array.isArray(t) ? t : TEMPLATES[t]);
const bbox = (t) => ({ w: Math.max(...tcells(t).map((c) => c[0])) + 1, h: Math.max(...tcells(t).map((c) => c[1])) + 1 });

// ------------------------------------------------------------------ style
// The IMD instrument wall (imd.fun; tokens from its CSS, see knowledge-base/sources/2026-10-05-design-language):
// flat light-gray faces with a 2px ink border on a gray wall, corner screws, black screens with green phosphor,
// patch jacks and cables, reels, meters, LED rows. Gray, black and green only. No gradients, no shadows.
// Lamps blink in steps, like the wall's.

const FACE = "#d6d6d2", INK = "#141414", DIM = "#5c5c58", WALL = "#7d7d79", SCREW = "#a3a39e", JACK = "#9a9a96";
const SCREEN = "#0a0a0a", LIT = "#39d353", MID = "#53af63", PALE = "#b0edba", OFF = "#2b4a31";
const BG = "#000";

// ------------------------------------------------------------------ drawing helpers

const r1 = (v) => String(Math.round(v * 10) / 10);
const pt = (x, y) => `${r1(x)} ${r1(y)}`;
const polar = (cx, cy, r, deg) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)]; // 0° = up, clockwise
const attrs = (o) => Object.entries(o).map(([k, v]) => ` ${k}="${typeof v === "number" ? r1(v) : v}"`).join("");
const rect = (x, y, w, h, o = {}) => `<rect${attrs({ x, y, width: w, height: h, ...o })}/>`;
const circle = (cx, cy, r, o = {}) => `<circle${attrs({ cx, cy, r, ...o })}/>`;
const path = (d, o = {}) => `<path${attrs({ d, ...o })}/>`;
const line = (d, color, w, o = {}) => path(d, { fill: "none", stroke: color, "stroke-width": w, ...o });
const ring = (cx, cy, r, color, w, o = {}) => circle(cx, cy, r, { fill: "none", stroke: color, "stroke-width": w, ...o });

/** cell centres and sockets of a template, in units */
const cellsOf = (tmpl) => tcells(tmpl).map(([cx, cy, m]) => ({ x: cx * C, y: cy * C, m }));

/** where each socket's jack sits: 6.5 in from the cell edge, on the edge's midline */
function jacksOf(tmpl) {
  const out = [];
  for (const { x, y, m } of cellsOf(tmpl)) {
    if (m & N) out.push([x + 20, y + 6.5, N]);
    if (m & E) out.push([x + 33.5, y + 20, E]);
    if (m & S) out.push([x + 20, y + 33.5, S]);
    if (m & W) out.push([x + 6.5, y + 20, W]);
  }
  return out;
}

// ------------------------------------------------------------------ layout checks
// Every part is checked as it is drawn: jacks, rarity dots, screws, screens, dials, knobs, lamps, labels and any
// declared area() register their boxes, and a part whose boxes overlap does not build.

let REG = null;
const GAP = 0.4; // minimum clearance between registered elements, in units
function reg(what, x, y, w, h) {
  if (REG) REG.push({ what, x, y, w, h });
}
/** declare the box an instrument occupies (draws nothing) */
const area = (what, x, y, w, h) => (reg(what, x, y, w, h), "");
function overlaps(list) {
  const bad = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP) bad.push(`${a.what} × ${b.what}`);
  }
  return bad;
}

// line weights: the module border, cables, instrument outlines, fine detail
const W_BORDER = 2, W_CABLE = 1.8, W_LINE = 1.3, W_FINE = 0.7;

/** a soft phosphor glow (the wall's lamps have one). The filter region is in user space so thin straight lines,
 *  whose bounding box has no width, still glow. */
const glowDefs = (id, [x, y, width, height]) => `<defs><filter${attrs({ id, filterUnits: "userSpaceOnUse", x, y, width, height })}><feGaussianBlur stdDeviation="0.9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
const GLOW_DEFS = glowDefs("glow", [-10, -10, 140, 140]);
const glow = (svg, id = "glow") => `<g filter="url(#${id})">${svg}</g>`;

/**
 * A module: the gray wall behind its cells and the face with its ink border and screws. Jacks are added on top of
 * everything by build(), so cables plug in underneath them.
 */
function module(tmpl, o = {}) {
  const { w, h } = bbox(tmpl);
  const face = o.face ?? FACE, border = o.border ?? INK;
  let s = "";
  if (tmpl === T.ELL) {
    s += path("M0 0H80V80H40V40H0Z", { fill: WALL });
    s += path("M2.5 2.5H77.5V77.5H42.5V37.5H2.5Z", { fill: face, stroke: border, "stroke-width": 2, "stroke-linejoin": "miter" });
  } else {
    s += rect(0, 0, w * C, h * C, { fill: WALL });
    s += rect(2.5, 2.5, w * C - 5, h * C - 5, { fill: face, stroke: border, "stroke-width": 2 });
  }
  if (o.screws !== false) {
    const pts = tmpl === T.ELL ? [[5.8, 5.8], [74.2, 5.8], [74.2, 74.2], [45.8, 74.2], [5.8, 34.2]]
      : [[5.8, 5.8], [w * C - 5.8, 5.8], [w * C - 5.8, h * C - 5.8], [5.8, h * C - 5.8]];
    s += pts.map(([x, y]) => (reg("screw", x - 1.8, y - 1.8, 3.6, 3.6), circle(x, y, 1.4, { fill: SCREW, stroke: DIM, "stroke-width": 0.7 }))).join("");
  }
  return s;
}

/** a jack at every socket; its lead runs through the border to the cell edge, so neighbouring jacks meet */
function fittings(tmpl, jack = JACK) {
  let s = "";
  for (const [x, y, d] of jacksOf(tmpl)) {
    if (d === N) s += rect(x - 1.5, y - 6.5, 3, 6.5, { fill: INK });
    if (d === E) s += rect(x, y - 1.5, 6.5, 3, { fill: INK });
    if (d === S) s += rect(x - 1.5, y, 3, 6.5, { fill: INK });
    if (d === W) s += rect(x - 6.5, y - 1.5, 6.5, 3, { fill: INK });
    s += circle(x, y, 3.4, { fill: INK }) + circle(x, y, 1.5, { fill: jack });
    reg("jack", x - 3.4, y - 3.4, 6.8, 6.8);
  }
  return s;
}

/** where the rarity dots go by default: top right of the face, clear of the corner screw */
function pipSpot(tmpl, screws) {
  const { w } = bbox(tmpl);
  return [w * C - (screws ? 9.5 : 5.6) - 7.2, 7.4];
}

/** rarity pips, the wall's "●●○○" marks: filled = rarity (1 common .. 4 legendary) */
const pips = (x, y, n, r = 1.1, gap = 3.2) => {
  reg("pips", x - r, y - r, 3 * gap + 2 * r, 2 * r);
  return Array.from({ length: 4 }, (_, i) => (i < n ? circle(x + i * gap, y, r, { fill: INK }) : ring(x + i * gap, y, r - 0.35, INK, 0.7))).join("");
};
/** an engraved label bar */
const label = (x, y, len) => (reg("label", x, y, len, 1.6), rect(x, y, len, 1.6, { fill: DIM }));
/** a black screen in a dim bezel */
const screen = (x, y, w, h) => (reg("screen", x - 1.5, y - 1.5, w + 3, h + 3), rect(x - 1.5, y - 1.5, w + 3, h + 3, { fill: JACK }) + rect(x, y, w, h, { fill: SCREEN }));
/** an indicator lamp, dark: put litLamp() at the same spot in a moving layer to light it */
const lamp = (x, y, r = 1.4, off = OFF) => (reg("lamp", x - r - 0.3, y - r - 0.3, 2 * r + 0.6, 2 * r + 0.6), circle(x, y, r, { fill: off, stroke: INK, "stroke-width": 0.5 }));
const litLamp = (x, y, r = 1.4, color = LIT) => glow(circle(x, y, r, { fill: color })) + circle(x - r * 0.35, y - r * 0.35, r * 0.32, { fill: "#fff", opacity: 0.55 });
const lampBox = (x, y, r = 1.4) => [x - r - 0.5, y - r - 0.5, 2 * r + 1, 2 * r + 1];
/** a patch-cable plug at the jack (x, y), its body running from 1.5 to `len` units away in direction d */
function plug(x, y, d, len = 7.4) {
  const seg = (a, b, w, o) => (d === S ? rect(x - w / 2, y + a, w, b - a, o) : d === N ? rect(x - w / 2, y - b, w, b - a, o)
    : d === E ? rect(x + a, y - w / 2, b - a, w, o) : rect(x - b, y - w / 2, b - a, w, o));
  return seg(1.5, len, 3.4, { fill: INK, rx: 0.8 }) + seg(len - 3.2, len - 2.3, 3.4, { fill: DIM });
}
/** dim phosphor graticule */
const grid = (d) => line(d, MID, 0.6, { opacity: 0.45 });
/** a knob: ink ring, face, pointer */
const knob = (cx, cy, r, deg, color = LIT) => (reg("knob", cx - r - 0.8, cy - r - 0.8, 2 * r + 1.6, 2 * r + 1.6), "") + circle(cx, cy, r, { fill: FACE, stroke: INK, "stroke-width": 1.6 }) + line(`M${pt(cx, cy)}L${pt(...polar(cx, cy, r - 1.2, deg))}`, color, 1.3, { "stroke-linecap": "round" });
/** a sine trace from x0 to x1 around y: amplitude a, period p */
function sine(x0, x1, y, a, p) {
  let d = `M${pt(x0, y)}`;
  for (let x = x0; x < x1; x += p / 2) {
    const k = Math.round((x - x0) / (p / 2)) % 2 ? 1 : -1;
    d += `Q${pt(x + p / 4, y + k * a * 2)} ${pt(x + p / 2, y)}`;
  }
  return d;
}
/** a radar sweep: a bright line with a fading wake behind it, turning clockwise about (cx, cy) */
function sweepWake(cx, cy, r) {
  let s = "";
  for (let k = 1; k <= 6; k++) s += path(`M${pt(cx, cy)}L${pt(...polar(cx, cy, r, -k * 7))}A${r} ${r} 0 0 1 ${pt(cx, cy - r)}Z`, { fill: LIT, opacity: 0.07 });
  return s + glow(line(`M${pt(cx, cy)}V${r1(cy - r)}`, PALE, 0.9));
}
/** a blip at bearing deg that flares as a sweep of period dur passes it, then fades */
function blip(cx, cy, r, deg, dur, size = 1.1) {
  const [x, y] = polar(cx, cy, r, deg);
  const n = 24, at = deg / 360;
  const fade = Array.from({ length: n + 1 }, (_, i) => { const d = (((i / n - at) % 1) + 1) % 1; return Math.max(0, 1 - d * 2.6); });
  return { svg: glow(circle(x, y, size, { fill: LIT })), box: [x - size - 0.5, y - size - 0.5, 2 * size + 1, 2 * size + 1], anim: { dur, ease: "lin", fade } };
}
/** a tape reel flange: a disc with three windows onto the tape and a hub (turn it as one) */
function reelFlange(cx, cy, r) {
  let d = `M${pt(cx + r, cy)}A${r} ${r} 0 1 0 ${pt(cx - r, cy)}A${r} ${r} 0 1 0 ${pt(cx + r, cy)}Z`;
  for (const a of [0, 120, 240]) {
    const ro = r * 0.78, ri = r * 0.36;
    const p = [polar(cx, cy, ri, a - 32), polar(cx, cy, ro, a - 40), polar(cx, cy, ro, a + 40), polar(cx, cy, ri, a + 32)];
    d += `M${pt(...p[0])}L${pt(...p[1])}A${r1(ro)} ${r1(ro)} 0 0 1 ${pt(...p[2])}L${pt(...p[3])}A${r1(ri)} ${r1(ri)} 0 0 0 ${pt(...p[0])}Z`;
  }
  return path(d, { fill: FACE, stroke: INK, "stroke-width": 0.6, "fill-rule": "evenodd" }) + circle(cx, cy, r * 0.2, { fill: INK }) + circle(cx, cy, r * 0.08, { fill: SCREW });
}
const diamond = (cx, cy, r, o) => path(`M${pt(cx, cy - r)}L${pt(cx + r, cy)} ${pt(cx, cy + r)} ${pt(cx - r, cy)}Z`, { "stroke-linejoin": "miter", ...o });

// ------------------------------------------------------------------ animation
// A moving layer: { svg, box: [x, y, w, h] (its area, for the canvas), clip?: [x, y, w, h], anim }
// anim: { dur (s), ease: "lin" | "sin" | "step", phase (0..1), rot: [cx, cy, [deg...]] | move: [[x, y]...], fade: [opacity...] }
// "lin" and "sin" spread keyframes evenly and interpolate ("sin" eases each segment). "step" holds each value
// for an equal share of the cycle, like the wall's lamps.

const SPLINE = ".45 0 .55 1";
function smil(a) {
  const begin = a.phase ? ` begin="-${r1(a.phase * a.dur)}s"` : "";
  const timing = (n) => {
    const base = ` dur="${a.dur}s"${begin} repeatCount="indefinite"`;
    if (a.ease === "step") return base + ` calcMode="discrete"`;
    if (a.ease !== "sin") return base;
    const kt = Array.from({ length: n }, (_, i) => r1(i / (n - 1)).replace(/^0\./, ".")).join(";");
    return base + ` calcMode="spline" keyTimes="${kt}" keySplines="${Array(n - 1).fill(SPLINE).join(";")}"`;
  };
  let s = "";
  if (a.rot) {
    const [cx, cy, v] = a.rot;
    s += `<animateTransform attributeName="transform" type="rotate" values="${v.map((d) => `${r1(d)} ${r1(cx)} ${r1(cy)}`).join(";")}"${timing(v.length)}/>`;
  }
  if (a.move) s += `<animateTransform attributeName="transform" type="translate" values="${a.move.map(([x, y]) => pt(x, y)).join(";")}"${timing(a.move.length)}/>`;
  if (a.fade) s += `<animate attributeName="opacity" values="${a.fade.map(r1).join(";")}"${timing(a.fade.length)}/>`;
  return s;
}

const still = (svg) => ({ svg });
const spin = (svg, cx, cy, r, dur, dir = 1, phase = 0) => ({ svg, box: [cx - r, cy - r, 2 * r, 2 * r], anim: { dur, ease: "lin", phase, rot: [cx, cy, [0, 360 * dir]] } });
const swing = (svg, cx, cy, r, dur, degs, phase = 0, ease = "sin") => ({ svg, box: [cx - r, cy - r, 2 * r, 2 * r], anim: { dur, ease, phase, rot: [cx, cy, degs] } });
const slide = (svg, box, dur, move, phase = 0, ease = "sin") => ({ svg, box, anim: { dur, ease, phase, move } });
const blink = (svg, box, dur, fade, phase = 0) => ({ svg, box, anim: { dur, ease: "step", phase, fade } });
/** a trace scrolling left through a window (clipped to it) */
const scroll = (svg, clip, period, dur) => ({ svg, box: [clip[0], clip[1], clip[2] + period, clip[3]], clip, anim: { dur, ease: "lin", move: [[0, 0], [-period, 0]] } });

// ------------------------------------------------------------------ the parts
// One part per (rarity, template) slot; the slot odds are fixed in Shapes.dropOdds. Rarity shows as pips,
// and in how much of the part is alive.

const PARTS = [
  // ---------------------------------------------------------------- common: one small instrument each
  {
    name: "Patch", tier: 0, tmpl: T.STRAIGHT, screws: false, about: "Patch cable, 30 cm. Both ends tested.",
    layers: () => {
      // plugs hang from the jacks; the cable sags between them
      const plug = (x) => rect(x - 1.7, 21, 3.4, 5.6, { fill: INK, rx: 0.8 }) + rect(x - 1.7, 23.6, 3.4, 0.9, { fill: DIM });
      return [
        still(module(0, { screws: false }) + label(6.5, 7, 8) + area("lamp", 17.6, 7.6, 4.8, 4.8) + circle(20, 10, 1.7, { fill: OFF, stroke: INK, "stroke-width": W_FINE })
          + line("M6.5 26.4C6.5 36 33.5 36 33.5 26.4", INK, W_CABLE, { "stroke-linecap": "round" }) + plug(6.5) + plug(33.5)),
        blink(glow(circle(20, 10, 1.7, { fill: LIT })), [18, 8, 4, 4], 3.2, [0, 0, 0, 1, 0, 1]),
      ];
    },
  },
  {
    name: "Bend", tier: 0, tmpl: T.CORNER, screws: false, about: "Right-angle cable guide, 90°. Minimum radius observed.",
    layers: () => {
      const cells = [[0, 0], [1, 0], [1, 1], [0, 1]];
      return [
        still(module(1, { screws: false }) + plug(33.5, 20, W) + plug(20, 33.5, N) + line("M26.1 20C21.6 20 20 21.6 20 26.1", INK, W_CABLE, { "stroke-linecap": "round" })
          + area("lamps", 6.6, 6.6, 9.8, 9.8) + rect(6.6, 6.6, 9.8, 9.8, { fill: INK, rx: 0.8 }) + cells.map(([c, r]) => rect(7.8 + c * 4.2, 7.8 + r * 4.2, 3.2, 3.2, { fill: OFF })).join("") + label(6.6, 31.5, 8)),
        slide(glow(rect(7.8, 7.8, 3.2, 3.2, { fill: LIT })), [7.3, 7.3, 8.6, 8.6], 2.4, cells.map(([c, r]) => [c * 4.2, r * 4.2]), 0, "step"),
      ];
    },
  },
  {
    name: "Splitter", tier: 0, tmpl: T.TEE, screws: false, about: "Passive Y-splitter. Insertion loss 3 dB.",
    layers: () => [
      still(module(2, { screws: false }) + line("M6.5 20H13M27 20H33.5M20 25V33.5", INK, W_CABLE) + area("block", 13, 15, 14, 10)
        + rect(13, 15, 14, 10, { fill: INK, rx: 1 }) + rect(14.6, 16.6, 10.8, 3.4, { fill: SCREEN }) + [16.8, 20, 23.2].map((x) => circle(x, 18.3, 0.9, { fill: OFF })).join("") + label(6.5, 7, 9)),
      slide(glow(circle(16.8, 18.3, 0.9, { fill: LIT })), [15.5, 17, 9, 2.6], 1.8, [[0, 0], [3.2, 0], [6.4, 0], [3.2, 0]], 0, "step"),
    ],
  },
  {
    name: "Selector", tier: 0, tmpl: T.CROSS, screws: false, about: "Rotary selector, four detents. 6 mm shaft.",
    layers: () => {
      const D = [45, 135, 225, 315];
      const head = path("M18.6 20L19 12.6Q20 11.6 21 12.6L21.4 20Z", { fill: INK }) + circle(20, 20, 4.2, { fill: INK }) + line("M20 18V13.6", FACE, 0.6);
      return [
        still(module(3, { screws: false }) + area("switch", 11.6, 11.6, 16.8, 16.8) + circle(20, 20, 5.6, { fill: SCREW, stroke: INK, "stroke-width": W_FINE }) + D.map((a) => circle(...polar(20, 20, 8.6, a), 0.8, { fill: OFF, stroke: INK, "stroke-width": 0.35 })).join("")),
        swing(head, 20, 20, 9, 6, D, 0, "step"),
        slide(glow(circle(...polar(20, 20, 8.6, 45), 0.8, { fill: LIT })), [10.5, 10.5, 19, 19], 6, D.map((a) => { const [x, y] = polar(20, 20, 8.6, a), [x0, y0] = polar(20, 20, 8.6, 45); return [x - x0, y - y0]; }), 0, "step"),
      ];
    },
  },
  {
    name: "Fader", tier: 0, tmpl: T.LONG, about: "Linear fader, 60 mm travel. Calibrated at install.",
    layers: () => {
      let ticks = "";
      for (let i = 0; i <= 10; i++) ticks += `M${r1(16 + i * 4.8)} 12.4V${i % 5 ? 14 : 15}`;
      return [
        still(module(5) + label(10, 6.6, 12) + line("M6.5 20H14M66 20H73.5", INK, W_CABLE) + area("fader", 14, 11.6, 52, 16.8) + line(ticks, INK, W_FINE)
          + rect(14, 18.8, 52, 2.4, { fill: INK, rx: 1.2 }) + line("M16 26.6H64", DIM, 0.5)),
        slide(rect(17.2, 15, 6.4, 10, { fill: FACE, stroke: INK, "stroke-width": W_LINE, rx: 0.8 }) + line("M17.8 17.6H23M17.8 22.4H23", DIM, 0.4) + glow(rect(19.9, 16.8, 1, 6.4, { fill: LIT })), [16.4, 14.2, 49, 11.6], 9, [[0, 0], [30, 0], [14, 0], [40, 0], [0, 0]]),
      ];
    },
  },
  {
    name: "Lamp", tier: 0, tmpl: T.CAP, screws: false, pips: [7.4, 33], about: "Pilot lamp, 12 V. Green lens.",
    layers: () => [
      still(module(4, { screws: false }) + line("M20 33.5V25", INK, W_CABLE) + area("lamp", 11.4, 7.9, 17.2, 17.2) + circle(20, 16.5, 8.2, { fill: SCREW, stroke: INK, "stroke-width": W_LINE })
        + ring(20, 16.5, 6.9, DIM, 0.4) + circle(20, 16.5, 5.6, { fill: "#1a3320", stroke: INK, "stroke-width": 0.8 })),
      blink(glow(circle(20, 16.5, 5.6, { fill: LIT })) + circle(20, 16.5, 3.4, { fill: PALE, opacity: 0.45 }), [13.9, 10.4, 12.2, 12.2], 4, [1, 1, 1, 0, 1, 0, 0, 0]),
      still(path("M16.4 14.2A4.4 4.4 0 0 1 20.2 12", { fill: "none", stroke: "#fff", "stroke-width": 0.9, "stroke-linecap": "round", opacity: 0.55 })),
    ],
  },

  // ---------------------------------------------------------------- uncommon
  {
    name: "Reel", tier: 1, tmpl: T.CROSS, screws: false, about: "Tape reel, 7 in. Quarter-inch tape.",
    layers: () => [
      still(module(3, { screws: false }) + area("reel", 10.8, 10.8, 18.4, 18.4) + circle(20, 20, 8.6, { fill: INK }) + circle(20, 20, 6.4, { fill: "#3b3a36" }) + ring(20, 20, 4.6, "#4a4944", 0.4)),
      spin(reelFlange(20, 20, 8.6), 20, 20, 9, 3.2),
    ],
  },
  {
    name: "Tape Deck", tier: 1, tmpl: T.LONG, pips: [36.4, 7.4], about: "Reel-to-reel deck. Erase head disconnected.",
    layers: () => {
      const btn = (x, icon, on) => rect(x, 29.4, 4.6, 3.6, { fill: INK, rx: 0.5 }) + path(icon, { fill: on ? LIT : DIM });
      return [
        still(module(5) + area("reel", 13.2, 7.2, 19.6, 19.6) + area("reel", 47.2, 7.2, 19.6, 19.6) + [23, 57].map((x) => circle(x, 17, 9.6, { fill: INK }) + circle(x, 17, 7.2, { fill: "#3b3a36" })).join("")
          + line("M16.6 24.2L37 26.6H43L63.4 24.2", "#2b2a27", 0.8) + area("head", 37, 24.4, 6, 3.6) + rect(37, 24.4, 6, 3.6, { fill: SCREW, stroke: INK, "stroke-width": 0.5, rx: 0.5 })
          + area("buttons", 29.4, 29.4, 22, 3.6) + btn(29.4, "M30.8 30.4L30.8 32L32.2 31.2Z", false) + btn(35.2, "M36.6 30.3H38.6V32.1H36.6Z", false) + btn(41, "M42.4 30.4L42.4 32L43.8 31.2Z", true) + btn(46.8, "M48.3 30.5A0.8 0.8 0 1 0 48.31 30.5Z", false)),
        spin(reelFlange(23, 17, 9.6), 23, 17, 10, 2.6),
        spin(reelFlange(57, 17, 9.6), 57, 17, 10, 2.6, 1, 0.3),
        blink(glow(path("M42.4 30.4L42.4 32L43.8 31.2Z", { fill: LIT })), [41.5, 29.6, 3, 3], 1.2, [1, 0.5]),
      ];
    },
  },
  {
    name: "VU Meter", tier: 1, tmpl: T.MANIFOLD, pips: [35.4, 7.4], about: "Dual VU meter, backlit. Left peak lamp sticks.",
    layers: () => {
      // each meter: a black window, a scale arc around a pivot hidden below the window, a needle clipped to it
      const X = [12, 50.5], Y = 7, MW = 17.5, MH = 17;
      const meter = (x) => {
        const cx = x + MW / 2, cy = Y + MH + 3.5, r = 13.5;
        let ticks = "";
        for (let a = -40; a <= 40; a += 10) ticks += `M${pt(...polar(cx, cy, r, a))}L${pt(...polar(cx, cy, r + (a % 20 ? 1.2 : 2), a))}`;
        return screen(x, Y, MW, MH) + line(`M${pt(...polar(cx, cy, r, -40))}A${r} ${r} 0 0 1 ${pt(...polar(cx, cy, r, 22))}`, PALE, W_FINE, { opacity: 0.85 })
          + line(`M${pt(...polar(cx, cy, r, 22))}A${r} ${r} 0 0 1 ${pt(...polar(cx, cy, r, 40))}`, RED_LIT, 1.4) + line(ticks, PALE, 0.6, { opacity: 0.85 });
      };
      const needle = (x, dur, degs, phase) => {
        const cx = x + MW / 2, cy = Y + MH + 3.5;
        return { ...swing(glow(line(`M${pt(cx, cy)}V${r1(cy - 16.2)}`, LIT, 0.75)), cx, cy, 19, dur, degs, phase), clip: [x, Y, MW, MH] };
      };
      const sw = (x, up) => rect(x, 12.5, 4.4, 9, { fill: INK, rx: 0.8 }) + rect(x + 1, up ? 13.5 : 16.9, 2.4, 3.6, { fill: SCREW });
      return [
        still(module(6) + meter(X[0]) + meter(X[1]) + area("switches", 33.5, 12.5, 13, 9) + sw(33.5, true) + sw(42.1, false) + circle(40, 26.5, 1.3, { fill: "#4a1512" }) + area("peak", 38.5, 25, 3, 3)),
        needle(X[0], 1.9, [-34, 8, -16, 26, -6, -34], 0),
        needle(X[1], 2.3, [-30, 18, -12, 34, -26, -30], 0.4),
        blink(glow(circle(40, 26.5, 1.3, { fill: RED_LIT })), [38, 24, 5, 5], 4.6, [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]),
      ];
    },
  },
  {
    name: "Gauge", tier: 1, tmpl: T.TEE, screws: false, pips: [7.4, 33], about: "Pressure gauge, 0–10 bar. Glass replaced.",
    layers: () => {
      const c = [20, 18.6];
      let ticks = "";
      for (let i = 0; i <= 12; i++) { const a = -135 + i * 22.5; ticks += `M${pt(...polar(...c, 6.4, a))}L${pt(...polar(...c, i % 3 ? 7.2 : 7.7, a))}`; }
      return [
        still(module(2, { screws: false }) + line("M20 28V33.5", INK, W_CABLE) + area("gauge", 10.6, 9.2, 18.8, 18.8) + circle(...c, 9.4, { fill: SCREW, stroke: INK, "stroke-width": W_LINE })
          + circle(...c, 8.2, { fill: "#ecece8", stroke: INK, "stroke-width": 0.5 }) + line(`M${pt(...polar(...c, 7, 90))}A7 7 0 0 1 ${pt(...polar(...c, 7, 135))}`, RED_LIT, 1.3) + line(ticks, INK, 0.6)),
        swing(path(`M${pt(c[0] - 0.7, c[1] + 1.6)}L${pt(c[0], c[1] - 7)}L${pt(c[0] + 0.7, c[1] + 1.6)}Z`, { fill: INK }), ...c, 8, 6, [-70, 40, 10, 75, -70]),
        still(circle(...c, 1.4, { fill: INK }) + circle(...c, 0.5, { fill: DIM })),
      ];
    },
  },
  {
    name: "Clock", tier: 1, tmpl: T.CORNER, screws: false, pips: [7.4, 33], about: "Panel clock, 24-hour dial. Runs four minutes fast.",
    layers: () => {
      const c = [16.6, 16.6];
      let ticks = "";
      for (let i = 0; i < 60; i += 5) ticks += `M${pt(...polar(...c, i % 15 ? 7.6 : 6.8, i * 6))}L${pt(...polar(...c, 8.4, i * 6))}`;
      return [
        still(module(1, { screws: false }) + area("clock", 5.8, 5.8, 21.6, 21.6) + circle(...c, 10.4, { fill: SCREW, stroke: INK, "stroke-width": W_LINE }) + circle(...c, 9.2, { fill: "#ecece8", stroke: INK, "stroke-width": 0.5 })
          + line(ticks, INK, 0.8)),
        spin(path(`M${pt(c[0] - 0.8, c[1] + 1)}L${pt(c[0] - 0.4, c[1] - 4.6)}H${r1(c[0] + 0.4)}L${pt(c[0] + 0.8, c[1] + 1)}Z`, { fill: INK }), ...c, 6, 720),
        spin(path(`M${pt(c[0] - 0.55, c[1] + 1.2)}L${pt(c[0] - 0.3, c[1] - 7.2)}H${r1(c[0] + 0.3)}L${pt(c[0] + 0.55, c[1] + 1.2)}Z`, { fill: INK }), ...c, 8, 60),
        spin(glow(line(`M${pt(c[0], c[1] + 2.4)}V${r1(c[1] - 8)}`, LIT, 0.45)), ...c, 9, 12),
        still(circle(...c, 1, { fill: INK }) + circle(...c, 0.4, { fill: LIT })),
      ];
    },
  },

  // ---------------------------------------------------------------- rare
  {
    name: "Radar", tier: 2, tmpl: T.HUB, about: "PPI display, 2 s sweep. Range rings every 10 km.",
    layers: () => {
      const c = [40, 37], R = 21.5, dur = 4;
      let ticks = "";
      for (let a = 0; a < 360; a += 15) ticks += `M${pt(...polar(...c, R - (a % 45 ? 1 : 2), a))}L${pt(...polar(...c, R, a))}`;
      return [
        still(module(9) + label(27, 6.6, 14) + area("scope", c[0] - R - 1.6, c[1] - R - 1.6, 2 * R + 3.2, 2 * R + 3.2) + circle(...c, R + 1.6, { fill: JACK }) + circle(...c, R, { fill: SCREEN })
          + [7, 14].map((r) => ring(...c, r, MID, 0.5, { opacity: 0.5 })).join("") + grid(`M${c[0] - R} ${c[1]}H${c[0] + R}M${c[0]} ${c[1] - R}V${c[1] + R}`) + line(ticks, MID, 0.5, { opacity: 0.7 })
          + knob(18, 69, 3.2, -40) + knob(28, 69, 3.2, 30) + knob(38, 69, 3.2, 80) + lamp(47, 69, 1.1)),
        spin(sweepWake(...c, R - 0.4), ...c, R, dur),
        blip(...c, 12, 52, dur), blip(...c, 17, 148, dur, 0.9), blip(...c, 9, 251, dur), blip(...c, 15.5, 318, dur, 0.9),
        blink(litLamp(47, 69, 1.1), lampBox(47, 69, 1.1), dur, [1, 0, 0, 0, 0, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Scope", tier: 2, tmpl: T.BAR3, pips: [16, 32.6], about: "Oscilloscope, single trace, 20 MHz. Probe ×10.",
    layers: () => {
      const S0 = [12.5, 12.5, 60, 15], mid = S0[1] + S0[3] / 2;
      let g = "";
      for (let i = 1; i < 10; i++) g += `M${r1(S0[0] + i * 6)} ${S0[1]}V${S0[1] + S0[3]}`;
      for (let j = 1; j < 4; j++) g += `M${S0[0]} ${r1(S0[1] + j * 5)}H${S0[0] + S0[2]}`;
      let minor = "";
      for (let x = S0[0] + 1.2; x < S0[0] + S0[2]; x += 1.2) minor += `M${r1(x)} ${r1(mid - 0.5)}V${r1(mid + 0.5)}`;
      return [
        still(module(7) + screen(...S0) + grid(g) + line(minor, MID, 0.35, { opacity: 0.6 }) + knob(84, 13.5, 3.6, -50) + knob(96, 13.5, 3.6, 40)
          + area("slider", 80, 23.4, 26, 4) + rect(80, 24.6, 26, 1.6, { fill: INK, rx: 0.8 }) + rect(80, 24.6, 15, 1.6, { fill: LIT, rx: 0.8 }) + circle(95, 25.4, 1.9, { fill: FACE, stroke: INK, "stroke-width": W_FINE })),
        scroll(line(sine(S0[0], S0[0] + S0[2] + 24, mid + 0.6, 3.6, 24), MID, 1.6, { opacity: 0.25 }), S0, 24, 1.8),
        scroll(glow(line(sine(S0[0], S0[0] + S0[2] + 24, mid, 3.4, 24), LIT, 1.1)), S0, 24, 1.8),
      ];
    },
  },
  {
    name: "Sequencer", tier: 2, tmpl: T.ELL, pips: [12, 33], about: "16-step analogue sequencer. Step 9 skips.",
    layers: () => {
      const X = (i) => 12 + i * 7.1;
      let ticks = "";
      for (let y = 42; y <= 64; y += 4.4) ticks += `M54.4 ${r1(y)}H56.4`;
      return [
        still(module(8) + area("pads", 11.8, 10.4, 55.4, 10.2) + Array.from({ length: 8 }, (_, i) => rect(X(i), 14.6, 5.2, 5.8, { fill: INK, rx: 0.6 }) + rect(X(i) + 0.8, 15.4, 3.6, 3.6, { fill: FACE, rx: 0.4 }) + circle(X(i) + 2.6, 11.8, 0.8, { fill: OFF })).join("")
          + screen(13, 25, 27, 5) + [0, 1, 2, 3, 4].map((i) => rect(15 + i * 4.8, 26.4, 3.4, 2.2, { fill: i < 3 ? MID : OFF })).join("") + knob(51, 27.6, 3.4, 30)
          + area("fader", 54, 40, 10, 26) + line(ticks, DIM, 0.6) + rect(58.8, 41, 2.4, 24, { fill: INK, rx: 1.2 }) + lamp(70, 44, 1.1)),
        slide(glow(circle(X(0) + 2.6, 11.8, 0.8, { fill: LIT })), [X(0) + 1.3, 10.5, 2.6, 2.6], 2.8, Array.from({ length: 8 }, (_, i) => [i * 7.1, 0]), 0, "step"),
        slide(glow(rect(X(0) + 0.8, 15.4, 3.6, 3.6, { fill: LIT, rx: 0.4 })), [X(0) + 0.3, 14.9, 4.6, 4.6], 2.8, Array.from({ length: 8 }, (_, i) => [i * 7.1, 0]), 0, "step"),
        slide(rect(55.2, 58.6, 9.6, 5, { fill: FACE, stroke: INK, "stroke-width": W_LINE, rx: 0.6 }) + glow(rect(56.6, 60.6, 6.8, 1, { fill: LIT })), [54.4, 41, 11.2, 24], 5.6, [[0, 0], [0, -15], [0, -6], [0, -13], [0, 0]]),
        blink(litLamp(70, 44, 1.1), lampBox(70, 44, 1.1), 2.8, [1, 0, 0, 0, 0, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Monitor", tier: 2, tmpl: T.CROSS, screws: false, about: "Monochrome monitor, 9 in. Status line reads OK.",
    layers: () => {
      const S0 = [12.6, 12.6, 14.8, 14.8];
      let scan = "";
      for (let y = 13.2; y < 27.4; y += 0.9) scan += `M12.6 ${r1(y)}H27.4`;
      return [
        still(module(3, { screws: false }) + area("crt", 11, 11, 18, 18) + rect(11, 11, 18, 18, { fill: INK, rx: 3 }) + rect(...S0, { fill: SCREEN, rx: 2.4 }) + grid("M12.6 20H27.4M20 12.6V27.4")),
        { ...scroll(glow(line(sine(S0[0], S0[0] + S0[2] + 7.4, 20, 2.6, 7.4), LIT, 1)), S0, 7.4, 1.1), clip: S0 },
        still(line(scan, "#000", 0.3, { opacity: 0.35 }) + path("M13.6 15.4Q14 13.6 15.8 13.4", { fill: "none", stroke: "#fff", "stroke-width": 0.6, opacity: 0.25 })),
      ];
    },
  },

  // ---------------------------------------------------------------- legendary
  {
    name: "Console", tier: 3, tmpl: T.BIGHUB, pips: [35.4, 7.4], about: "Control console, 64 switches. All live.",
    layers: () => {
      const S0 = [13, 12.5, 54, 21.5], mid = S0[1] + S0[3] / 2;
      let g = "";
      for (let i = 1; i < 6; i++) g += `M${r1(S0[0] + i * 9)} ${S0[1]}V${S0[1] + S0[3]}`;
      g += `M${S0[0]} ${mid}H${S0[0] + S0[2]}`;
      const L = (i) => 14.6 + i * 6.6;
      return [
        still(module(10) + screen(...S0) + grid(g) + knob(19, 43, 3.6, -60) + knob(31, 43, 3.6, 20) + knob(43, 43, 3.6, 70) + knob(55, 43, 3.6, -10)
          + area("lamps", 13.6, 50.4, 52.4, 5.2) + rect(13.6, 50.4, 52.4, 5.2, { fill: INK, rx: 0.8 }) + Array.from({ length: 8 }, (_, i) => rect(L(i), 51.6, 4, 2.8, { fill: OFF })).join("")
          + label(14, 61, 18) + area("fader", 40, 59.6, 26, 4) + rect(40, 60.8, 26, 1.6, { fill: INK, rx: 0.8 })),
        scroll(glow(line(sine(S0[0], S0[0] + S0[2] + 27, mid - 1, 4.4, 27), LIT, 1.1)), S0, 27, 2.4),
        scroll(line(sine(S0[0], S0[0] + S0[2] + 13.5, mid + 3, 1.8, 13.5), PALE, 0.7, { opacity: 0.7 }), S0, 13.5, 0.9),
        slide(glow(rect(L(0), 51.6, 4, 2.8, { fill: LIT })), [L(0) - 0.5, 51.1, 5, 3.8], 2.6, [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1].map((i) => [i * 6.6, 0]), 0, "step"),
        slide(circle(42, 61.6, 2, { fill: FACE, stroke: INK, "stroke-width": W_FINE }) + glow(circle(42, 61.6, 0.6, { fill: LIT })), [39.4, 59, 26, 5.2], 3.2, [[0, 0], [20, 0], [8, 0], [16, 0], [0, 0]]),
      ];
    },
  },
  {
    name: "Reactor", tier: 3, tmpl: T.REACTOR, pips: [25.5, 9], about: "Sealed power unit. No user-serviceable parts inside.",
    layers: () => {
      const c = [60, 54];
      let seg = "";
      for (let y = 35; y < 82; y += 2.4) seg += `M13 ${r1(y)}H20M100 ${r1(y)}H107`;
      let ring12 = "";
      for (let a = 0; a < 360; a += 30) ring12 += path(`M${pt(...polar(...c, 35, a + 3))}A35 35 0 0 1 ${pt(...polar(...c, 35, a + 25))}L${pt(...polar(...c, 31.2, a + 25))}A31.2 31.2 0 0 0 ${pt(...polar(...c, 31.2, a + 3))}Z`, { fill: SCREW, stroke: INK, "stroke-width": 0.5 });
      const L = (i) => 33 + i * 5.6;
      return [
        still(module(11) + label(70, 8.2, 18) + area("core", c[0] - 36.6, c[1] - 36.6, 73.2, 73.2) + circle(...c, 36.6, { fill: INK }) + circle(...c, 29.4, { fill: JACK }) + circle(...c, 27.8, { fill: SCREEN })
          + ring(...c, 18.6, MID, 0.45, { opacity: 0.5 }) + grid(`M${c[0] - 27.8} ${c[1]}H${c[0] + 27.8}M${c[0]} ${c[1] - 27.8}V${c[1] + 27.8}`)
          + screen(13, 34, 7, 48) + screen(100, 34, 7, 48) + screen(31, 94.5, 58, 7) + Array.from({ length: 10 }, (_, i) => rect(L(i), 96, 3.6, 4, { fill: OFF })).join("")),
        spin(ring12, ...c, 35.6, 20),
        spin(ring(...c, 23.4, MID, 1.4, { "stroke-dasharray": "3 4.35" }) + [0, 120, 240].map((a) => glow(circle(...polar(...c, 23.4, a), 1.4, { fill: LIT }))).join(""), ...c, 25, 12, -1),
        blink(glow(circle(...c, 13, { fill: LIT, opacity: 0.22 })), [45, 39, 30, 30], 2.6, [0.5, 1, 1, 0.6]),
        still(glow(circle(...c, 8.6, { fill: LIT })) + diamond(...c, 5.4, { fill: SCREEN, stroke: SCREEN, "stroke-width": 0.8 }) + diamond(...c, 2.2, { fill: PALE })),
        { ...slide(glow(rect(13, 34, 7, 48, { fill: LIT })), [13, 34, 7, 80], 3.4, [[0, 30], [0, 8], [0, 20], [0, 4], [0, 30]]), clip: [13, 34, 7, 48] },
        { ...slide(glow(rect(100, 34, 7, 48, { fill: LIT })), [100, 34, 7, 80], 2.9, [[0, 14], [0, 36], [0, 6], [0, 24], [0, 14]], 0.3), clip: [100, 34, 7, 48] },
        still(line(seg, SCREEN, 0.8)),
        slide(glow(rect(L(0), 96, 3.6, 4, { fill: LIT }) + rect(L(1), 96, 3.6, 4, { fill: LIT })), [L(0) - 0.5, 95.5, 10.2, 5], 3, Array.from({ length: 9 }, (_, i) => [i * 5.6, 0]), 0, "step"),
      ];
    },
  },

  // ---------------------------------------------------------------- agent core (identity.md seat holders)
  {
    name: "Agent Core", tier: 4, tmpl: T.CROSS, screws: false, pips: false, jack: OFF, about: "Agent core, sealed unit. Serial engraved on the back.",
    layers: () => {
      let pins = "";
      for (const v of [13.2, 26.8]) pins += `M${v} 3.6V6.4M${v} 33.6V36.4M3.6 ${v}H6.4M33.6 ${v}H36.4`;
      return [
        still(module(3, { screws: false, face: "#0c110d", border: LIT }) + line(pins, MID, 1, { opacity: 0.8 }) + area("chip", 11.4, 11.4, 17.2, 17.2) + rect(11.4, 11.4, 17.2, 17.2, { fill: SCREEN, stroke: "#1f3b26", "stroke-width": 0.8, rx: 1 })
          + diamond(20, 20, 6.6, { fill: "none", stroke: OFF, "stroke-width": 1.8 })),
        blink(glow(diamond(20, 20, 6.6, { fill: "none", stroke: LIT, "stroke-width": 1.8 })) + rect(18.8, 18.8, 2.4, 2.4, { fill: PALE }), [12, 12, 16, 16], 1.8, [1, 0.35]),
      ];
    },
  },
];

// ------------------------------------------------------------------ live digits
// Seven-segment digits, 10 units tall. The site's canvas renderer draws live values with the
// same geometry (tenths of a unit), so keep the two in step. A live layer marks its place in the SVG with "@@".

const SEG = [[12, 0, 31, 12], [43, 12, 12, 32], [43, 56, 12, 32], [12, 88, 31, 12], [0, 56, 12, 32], [0, 12, 12, 32], [12, 44, 31, 12]];
const DIGIT = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
/** n digits at (x, y); value null draws every segment (the unlit "8"s behind a display) */
function digits(x, y, n, value, color) {
  const X = Math.round(x * 10), Y = Math.round(y * 10);
  const str = value === null ? null : String(Math.min(value, 10 ** n - 1)).padStart(n, "0");
  let s = "";
  for (let k = 0; k < n; k++) {
    const m = str === null ? 127 : DIGIT[+str[k]];
    SEG.forEach(([dx, dy, w, h], i) => { if ((m >> i) & 1) s += rect((X + k * 75 + dx) / 10, (Y + dy) / 10, w / 10, h / 10, { fill: color }); });
  }
  return s;
}
const LIVE = { minted: 1, paid: 2 };
/** a live number: the parts minted so far, or whole IMD paid to builders */
const live = (kind, x, y, n) => ({ svg: "@@", live: { kind, x, y, n } });

// ------------------------------------------------------------------ more parts: several per slot
// A mint picks a slot by the fixed odds, then one of the slot's parts uniformly, so these add variety
// without changing anyone's odds of a rarity or a shape.

/** a tiny deterministic random source for patterns (lamp matrices, punch tape, spectra) */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const RED = "#b3261e", RED_LIT = "#ff6b62", PAPER = "#ecece8";

PARTS.push(
  // ---------------------------------------------------------------- common
  {
    name: "Toggle", tier: 0, tmpl: T.STRAIGHT, screws: false, about: "Toggle switch, SPDT. Lever slightly bent.",
    layers: () => {
      // a bat-handle toggle on a plate; the lamp below shows which way it is
      const bat = path("M18.9 20L19.3 11.8H20.7L21.1 20Z", { fill: FACE, stroke: INK, "stroke-width": W_FINE, "stroke-linejoin": "round" }) + circle(20, 11.6, 1.6, { fill: FACE, stroke: INK, "stroke-width": W_FINE });
      return [
        still(module(0, { screws: false }) + label(6.5, 7, 8) + line("M6.5 20H12.5M27.5 20H33.5", INK, W_CABLE)
          + area("plate", 12.5, 14, 15, 12) + rect(12.5, 14, 15, 12, { fill: INK, rx: 1 }) + circle(15, 16.5, 0.7, { fill: DIM }) + circle(25, 16.5, 0.7, { fill: DIM })
          + circle(20, 20, 3, { fill: SCREW, stroke: INK, "stroke-width": W_FINE }) + lamp(20, 30.5, 1.3)),
        swing(bat, 20, 20, 10, 5, [-28, 28], 0, "step"),
        still(circle(20, 20, 1.2, { fill: DIM })),
        blink(litLamp(20, 30.5, 1.3), lampBox(20, 30.5, 1.3), 5, [0, 1]),
      ];
    },
  },
  {
    name: "Fuse", tier: 0, tmpl: T.STRAIGHT, screws: false, about: "Cartridge fuse, 250 V 2 A. Holder finger-tight.",
    layers: () => {
      const zig = "M14.6 20H15.6L16.6 18.2 17.6 21.8 18.6 18.2 19.6 21.8 20.6 18.2 21.6 21.8 22.6 18.2 23.6 21.8 24.4 20H25.4";
      const cap = (x) => rect(x, 16.4, 3.6, 7.2, { fill: SCREW, stroke: INK, "stroke-width": W_FINE, rx: 0.6 }) + line(`M${x + 1.2} 16.4V23.6M${x + 2.4} 16.4V23.6`, DIM, 0.4);
      return [
        still(module(0, { screws: false }) + label(6.5, 7, 8) + line("M6.5 20H11M29 20H33.5", INK, W_CABLE) + area("fuse", 11, 16.4, 18, 7.2)
          + rect(14.6, 17, 10.8, 6, { fill: "#e4ebe5", stroke: INK, "stroke-width": W_FINE }) + line(zig, DIM, 0.5) + cap(11) + cap(25.4)
          + label(15, 28.5, 10)),
        blink(rect(15.1, 17.5, 9.8, 5, { fill: LIT, opacity: 0.16 }) + glow(line(zig, LIT, 0.7)), [14, 16, 12, 8], 2.6, [1, 0.5, 1, 1, 0.2, 1, 0.8, 1, 1, 0.4]),
        still(line("M15.4 18H24.6", "#fff", 0.5, { opacity: 0.6 })),
      ];
    },
  },
  {
    name: "Knob", tier: 0, tmpl: T.CORNER, screws: false, pips: [7.4, 33], about: "Rotary control, 300° travel. Detent at 12 o'clock.",
    layers: () => {
      const c = 16.5;
      let ticks = "";
      for (let i = 0; i <= 10; i++) { const a = -135 + i * 27; ticks += `M${pt(...polar(c, c, 9.2, a))}L${pt(...polar(c, c, i % 5 ? 10.4 : 11, a))}`; }
      let knurl = "";
      for (let a = 0; a < 360; a += 20) knurl += `M${pt(...polar(c, c, 6.2, a))}L${pt(...polar(c, c, 7.3, a))}`;
      return [
        still(module(1, { screws: false }) + area("knob", c - 11.2, c - 11.2, 22.4, 22.4) + line(ticks, INK, W_FINE) + circle(c, c, 7.4, { fill: INK })),
        swing(line(knurl, DIM, 0.6) + circle(c, c, 5.6, { fill: SCREW, stroke: INK, "stroke-width": 0.5 }) + line(`M${c} ${c}V${c - 5}`, INK, 1.4, { "stroke-linecap": "round" }) + glow(circle(c, c - 6.6, 0.7, { fill: LIT })), c, c, 8, 11, [-120, 60, -30, 120, -120]),
      ];
    },
  },
  {
    name: "Keypad", tier: 0, tmpl: T.CORNER, screws: false, about: "Membrane keypad, 9 keys. Key 5 worn smooth.",
    layers: () => {
      let keys = "";
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) keys += rect(8 + c * 5.8, 8 + r * 5.8, 4.6, 4.6, { fill: FACE, rx: 0.5 }) + rect(8 + c * 5.8, 11.9 + r * 5.8, 4.6, 0.7, { fill: SCREW });
      const seq = [[0, 0], [2, 1], [1, 0], [0, 2], [2, 2], [1, 1], [2, 0], [0, 1]].map(([c, r]) => [c * 5.8, r * 5.8]);
      return [
        still(module(1, { screws: false }) + area("keypad", 6.6, 6.6, 19.2, 19.2) + rect(6.6, 6.6, 19.2, 19.2, { fill: INK, rx: 1 }) + keys + lamp(30.5, 30.5, 1.3)),
        slide(glow(rect(8, 8, 4.6, 4.6, { fill: LIT, rx: 0.5 })), [7.5, 7.5, 5.6, 5.6], 3.2, seq, 0, "step"),
        blink(litLamp(30.5, 30.5, 1.3), lampBox(30.5, 30.5, 1.3), 3.2, [0, 0, 0, 0, 0, 0, 0, 1]),
      ];
    },
  },
  {
    name: "Buttons", tier: 0, tmpl: T.TEE, screws: false, pips: [7.4, 33], about: "Three momentary buttons, 12 mm caps.",
    layers: () => {
      const X = [9.6, 17.25, 24.9];
      return [
        still(module(2, { screws: false }) + line("M6.5 20H33.5M20 20V33.5", INK, W_CABLE) + circle(20, 20, 1.9, { fill: INK })
          + area("buttons", 9, 6.4, 22, 7) + X.map((x) => rect(x - 0.6, 6.4, 6.7, 6.7, { fill: INK, rx: 1 }) + rect(x + 0.3, 7.3, 4.9, 4.9, { fill: FACE, rx: 0.6 })).join("")
          + X.map((x) => rect(x + 1, 14.6, 3.4, 1.1, { fill: DIM })).join("")),
        slide(glow(rect(9.9, 7.3, 4.9, 4.9, { fill: LIT, rx: 0.6 })), [9.4, 6.8, 21, 5.9], 2.4, [[0, 0], [15.3, 0], [7.65, 0], [15.3, 0], [0, 0], [7.65, 0]], 0, "step"),
      ];
    },
  },
  {
    name: "LED Bar", tier: 0, tmpl: T.TEE, screws: false, pips: [7.4, 33], about: "10-segment bargraph. Three red, seven green.",
    layers: () => {
      const L = [2, 4, 6, 5, 3, 4, 6, 6, 4, 2, 1, 3];
      const x = (i) => 9.6 + i * 3.6;
      return [
        still(module(2, { screws: false }) + line("M6.5 20H33.5M20 20V33.5", INK, W_CABLE) + circle(20, 20, 1.9, { fill: INK })
          + area("bar", 8.4, 6.4, 23.2, 7) + rect(8.4, 6.4, 23.2, 7, { fill: INK, rx: 1 }) + Array.from({ length: 6 }, (_, i) => rect(x(i), 7.8, 2.8, 4.2, { fill: i === 5 ? "#4a1512" : OFF })).join("")),
        ...Array.from({ length: 6 }, (_, i) => blink(glow(rect(x(i), 7.8, 2.8, 4.2, { fill: i === 5 ? RED_LIT : LIT })), [x(i) - 0.5, 7.3, 3.8, 5.2], 2.4, L.map((l) => (l > i ? 1 : 0)))),
      ];
    },
  },
  {
    name: "Speaker", tier: 0, tmpl: T.CROSS, screws: false, about: "Panel speaker, 8 Ω 3 W. Grille dented.",
    layers: () => {
      let holes = "";
      for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
        const x = 20 + i * 1.8 + (j % 2 ? 0.9 : 0), y = 20 + j * 1.56;
        if (Math.hypot(x - 20, y - 20) < 7.4 && Math.hypot(x - 20, y - 20) > 3.2) holes += circle(x, y, 0.5, { fill: "#55554f" });
      }
      return [
        still(module(3, { screws: false }) + area("grille", 11.2, 11.2, 17.6, 17.6) + circle(20, 20, 8.6, { fill: INK }) + ring(20, 20, 8.6, SCREW, 0.6) + holes + circle(20, 20, 2.6, { fill: "#2c2c2a", stroke: "#55554f", "stroke-width": 0.5 })),
        blink(ring(20, 20, 2.6, DIM, 0.8) + ring(20, 20, 3.6, "#3a3a37", 0.6), [16, 16, 8, 8], 1.6, [1, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Crosshair", tier: 0, tmpl: T.CROSS, screws: false, about: "Illuminated reticle. Zeroed at 100 m.",
    layers: () => [
      still(module(3, { screws: false }) + screen(12, 12, 16, 16) + grid("M12 20H28M20 12V28") + ring(20, 20, 4.6, MID, 0.5, { opacity: 0.55 })
        + line("M19 14H21M19 26H21M14 19V21M26 19V21", MID, 0.4, { opacity: 0.6 })),
      { ...slide(glow(circle(20, 20, 1, { fill: LIT }) + ring(20, 20, 2.2, LIT, 0.45)), [17, 17, 6, 6], 4, [[0, 0], [-4, 3], [3, -4], [5, 4], [-3, -3], [1, 5]], 0, "step"), clip: [12, 12, 16, 16] },
    ],
  },
  {
    name: "Odometer", tier: 0, tmpl: T.LONG, about: "Six-digit counter, mechanical. No reset.",
    layers: () => [
      still(module(5) + label(10, 6.6, 12) + line("M6.5 20H14M66 20H73.5", INK, W_CABLE) + screen(15.5, 13, 47, 14) + digits(17.5, 15, 6, null, "#16301c") + lamp(64.5, 30.5, 1.1)),
      live("minted", 17.5, 15, 6),
      blink(litLamp(64.5, 30.5, 1.1), lampBox(64.5, 30.5, 1.1), 2, [1, 0]),
    ],
  },
  {
    name: "Thermometer", tier: 0, tmpl: T.LONG, about: "Bimetal thermometer, 0–120 °C. Accuracy ±2 °C.",
    layers: () => {
      let ticks = "";
      for (let i = 0; i <= 18; i++) ticks += `M${r1(22 + i * 2.4)} 13.6V${i % 6 ? 15 : 16}`;
      return [
        still(module(5) + label(10, 6.6, 12) + line("M6.5 20H11M66 20H73.5", INK, W_CABLE) + area("thermometer", 11, 12.8, 55, 12) + line(ticks, INK, 0.5)
          + rect(19.4, 18, 46, 4, { fill: "#e4ebe5", stroke: INK, "stroke-width": W_FINE, rx: 2 }) + circle(15.6, 20, 4.6, { fill: "#e4ebe5", stroke: INK, "stroke-width": W_FINE })
          + glow(circle(15.6, 20, 3.4, { fill: LIT }) + rect(17, 19, 3, 2, { fill: LIT }))),
        { ...slide(glow(rect(18, 19, 46, 2, { fill: LIT, rx: 1 })), [15.5, 16.5, 51, 7], 9, [[-40, 0], [-14, 0], [-28, 0], [-6, 0], [-40, 0]]), clip: [19.4, 18, 45.2, 4] },
        still(line("M20.6 18.9H63.6", "#fff", 0.45, { opacity: 0.7 }) + label(22, 27.4, 20)),
      ];
    },
  },
  {
    name: "Big Button", tier: 0, tmpl: T.CAP, screws: false, pips: [7.4, 33], about: "Mushroom push button, 40 mm. Rated 10,000 presses.",
    layers: () => [
      // a panel-mount mushroom button: a metal collar on the face, the red cap standing proud of it (a dark crescent
      // shows under its lower edge), an engraved label bar above
      still(module(4, { screws: false }) + line("M20 33.5V26", INK, W_CABLE) + label(15.5, 4.4, 9) + area("button", 11, 8, 18, 18)
        + circle(20, 17, 9, { fill: SCREW, stroke: INK, "stroke-width": 0.9 }) + circle(20, 17, 7.4, { fill: INK })
        + circle(20, 16.1, 7, { fill: "#5a120e" }) + circle(20, 15.7, 6.5, { fill: RED })
        + circle(20, 15.2, 4.4, { fill: "#c8392f" })
        + path("M16.9 13.2A3.9 3.9 0 0 1 20.5 11.1", { fill: "none", stroke: "#fff", "stroke-width": 0.9, "stroke-linecap": "round", opacity: 0.4 })),
      // pressed: the cap sinks into the collar, smaller and darker, twice in quick succession
      blink(circle(20, 17, 7.9, { fill: SCREW }) + circle(20, 17, 7.4, { fill: INK }) + circle(20, 17.2, 6.2, { fill: "#7e1913" })
        + circle(20, 17, 4.3, { fill: "#9c2219" }), [11.5, 8.5, 17, 17], 6, [0, 0, 0, 0, 0, 1, 0, 1]),
    ],
  },
  {
    name: "Antenna", tier: 0, tmpl: T.CAP, screws: false, pips: [7.4, 33], about: "Telescopic antenna, five sections. Fully extended.",
    layers: () => {
      const arc = (r, a0, a1, sweep) => `M${pt(...polar(20, 9, r, a0))}A${r} ${r} 0 0 ${sweep} ${pt(...polar(20, 9, r, a1))}`;
      return [
        still(module(4, { screws: false }) + line("M20 33.5V29", INK, W_CABLE) + area("mast", 12.4, 4.4, 15.2, 25)
          + rect(14.6, 25.4, 10.8, 3.6, { fill: INK, rx: 0.8 }) + line("M20 25.4V10.6", INK, W_LINE) + line("M16.4 14.4H23.6M17.2 18.4H22.8M18 22H22", INK, 1)
          + circle(20, 9, 1.5, { fill: OFF, stroke: INK, "stroke-width": 0.5 })),
        blink(litLamp(20, 9, 1.5), lampBox(20, 9, 1.5), 2.4, [1, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
        blink(glow(line(arc(3.6, -60, -120, 0) + arc(3.6, 60, 120, 1), LIT, 0.7)), [15.4, 4.6, 9.2, 9], 2.4, [0, 1, 0, 0, 0, 1, 0, 0, 0, 0]),
        blink(line(arc(6, -58, -122, 0) + arc(6, 58, 122, 1), MID, 0.6), [13, 2.6, 14, 13], 2.4, [0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      ];
    },
  },

  // ---------------------------------------------------------------- uncommon
  {
    name: "Vent Fan", tier: 1, tmpl: T.CROSS, screws: false, about: "Axial fan, 80 mm, 2,400 rpm. Filter due.",
    layers: () => {
      const blades = Array.from({ length: 5 }, (_, i) => {
        const a = i * 72;
        const [x0, y0] = polar(20, 20, 2.4, a - 22), [x1, y1] = polar(20, 20, 8, a + 8), [x2, y2] = polar(20, 20, 8, a + 38), [x3, y3] = polar(20, 20, 2.4, a + 26), [cx, cy] = polar(20, 20, 6.4, a - 6);
        return path(`M${pt(x0, y0)}Q${pt(cx, cy)} ${pt(x1, y1)}A8 8 0 0 1 ${pt(x2, y2)}L${pt(x3, y3)}Z`, { fill: "#8f8f8a", stroke: INK, "stroke-width": 0.4 });
      }).join("");
      return [
        still(module(3, { screws: false }) + area("fan", 11, 11, 18, 18) + rect(11, 11, 18, 18, { fill: INK, rx: 2 }) + circle(20, 20, 8.4, { fill: "#1d1d1b" }) + [[12.6, 12.6], [27.4, 12.6], [27.4, 27.4], [12.6, 27.4]].map(([x, y]) => circle(x, y, 0.8, { fill: DIM })).join("")),
        spin(blades, 20, 20, 8.6, 0.9),
        still(ring(20, 20, 8.4, INK, 1) + ring(20, 20, 5.8, "#2a2a28", 0.7) + line("M11.6 20H28.4M20 11.6V28.4", "#2a2a28", 0.7) + circle(20, 20, 2.4, { fill: "#2a2a28", stroke: DIM, "stroke-width": 0.4 })),
      ];
    },
  },
  {
    name: "Cassette", tier: 1, tmpl: T.MANIFOLD, pips: [35.4, 33.2], about: "C60 compact cassette. Write-protect tabs removed.",
    layers: () => {
      const hub = (cx) => circle(cx, 17.6, 2.7, { fill: FACE }) + line([0, 60, 120, 180, 240, 300].map((a) => `M${pt(...polar(cx, 17.6, 1.2, a))}L${pt(...polar(cx, 17.6, 2.6, a))}`).join(""), INK, 0.7) + circle(cx, 17.6, 1, { fill: INK });
      return [
        still(module(6) + area("cassette", 13, 7, 54, 22) + rect(13, 7, 54, 22, { fill: INK, rx: 1.6 }) + rect(16, 9, 48, 13.6, { fill: PAPER, rx: 0.6 }) + rect(16, 9, 48, 2.4, { fill: MID })
          + line("M18 13.4H62M18 21.2H28M52 21.2H62", "#c9c9c3", 0.45) + rect(25.4, 14.4, 29.2, 6.4, { fill: SCREEN, rx: 3.2 })
          + circle(31, 17.6, 4.6, { fill: "#33322e" }) + circle(49, 17.6, 3.4, { fill: "#33322e" }) + path("M24 29L26.6 24.8H53.4L56 29Z", { fill: "#2a2a28" })
          + [29.4, 50.6].map((x) => circle(x, 27, 0.8, { fill: JACK })).join("") + [[14.6, 8.6], [65.4, 8.6], [14.6, 27.4], [65.4, 27.4]].map(([x, y]) => circle(x, y, 0.6, { fill: DIM })).join("")),
        spin(hub(31), 31, 17.6, 3, 1.6),
        spin(hub(49), 49, 17.6, 3, 1.6),
      ];
    },
  },
  {
    name: "Punch Reader", tier: 1, tmpl: T.LONG, about: "Optical tape reader, 8-track. 300 characters per second.",
    layers: () => {
      let holes = "";
      for (let x = 10; x < 70 + 32; x += 4) {
        const r2 = lcg(100 + Math.round(((x - 10) / 4) % 8));
        holes += circle(x + 2, 20, 0.45, { fill: INK });
        for (const y of [14.8, 17.4, 22.6, 25.2]) if (r2() < 0.5) holes += circle(x + 2, y, 0.85, { fill: INK });
      }
      return [
        still(module(5) + label(10, 6.6, 12) + line("M6.5 20H10.6M69.4 20H73.5", INK, W_CABLE) + area("tape", 10.6, 9, 58.8, 22) + rect(12, 12.4, 56, 15.2, { fill: PAPER })
          + [12.4, 67.6].map((x) => circle(x, 20, 1.8, { fill: SCREW, stroke: INK, "stroke-width": 0.5 })).join("")),
        scroll(holes, [12, 12.4, 56, 15.2], 32, 3.2),
        still(line("M12 12.4H68M12 27.6H68", INK, 0.8) + rect(35.6, 9, 8.8, 22, { fill: INK, rx: 1 }) + rect(37, 18.6, 6, 2.8, { fill: "#2a2a28" }) + circle(40, 12, 1.1, { fill: OFF, stroke: INK, "stroke-width": 0.5 })),
        blink(litLamp(40, 12, 1.1), lampBox(40, 12, 1.1), 1.6, [1, 0, 1, 1, 0, 1, 0, 0]),
      ];
    },
  },
  {
    name: "Metronome", tier: 1, tmpl: T.TEE, screws: false, pips: [7.4, 33], about: "Clockwork metronome, 40–208 bpm. Weight at 120.",
    layers: () => {
      let ticks = "";
      for (let y = 12; y <= 22; y += 2.5) ticks += `M19 ${y}H21`;
      return [
        still(module(2, { screws: false }) + area("metronome", 11.6, 7.6, 16.8, 21.6) + rect(11.6, 26.6, 16.8, 2.6, { fill: INK, rx: 0.6 }) + path("M13.6 26.6L17.2 8H22.8L26.4 26.6Z", { fill: SCREW, stroke: INK, "stroke-width": W_LINE, "stroke-linejoin": "round" })
          + rect(18.6, 10.4, 2.8, 14, { fill: "#2a2a28", rx: 0.6 }) + line(ticks, DIM, 0.5) + line("M20 29.2V33.5", INK, W_CABLE) + lamp(31.4, 10.6, 1.2)),
        swing(line("M20 25V9.2", INK, 0.9) + rect(18.4, 13, 3.2, 2.6, { fill: FACE, stroke: INK, "stroke-width": 0.5 }) + circle(20, 25, 1, { fill: INK }), 20, 25, 17, 1.2, [-24, 24, -24]),
        blink(litLamp(31.4, 10.6, 1.2), lampBox(31.4, 10.6, 1.2), 1.2, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Radio", tier: 1, tmpl: T.CORNER, screws: false, pips: [7.4, 33], about: "Shortwave receiver, 3–30 MHz. Dial lamp out.",
    layers: () => {
      let slots = "";
      for (let y = 8.6; y < 18; y += 1.8) slots += `M8.6 ${r1(y)}H17.4`;
      let ticks = "";
      for (let x = 8.6; x <= 26.6; x += 1.5) ticks += `M${r1(x)} 23.6V${Math.round((x - 8.6) / 1.5) % 4 ? 24.6 : 25.4}`;
      return [
        still(module(1, { screws: false }) + area("grille", 6.6, 6.6, 13, 13) + rect(6.6, 6.6, 13, 13, { fill: INK, rx: 1 }) + line(slots, "#4a4a46", 0.8, { "stroke-linecap": "round" })
          + knob(25, 11.4, 3.2, 40) + lamp(25, 18, 1)
          + screen(7.6, 22.8, 20, 5) + line(ticks, PALE, 0.4, { opacity: 0.8 })),
        { ...slide(glow(rect(9, 22.8, 0.7, 5, { fill: LIT })), [8.4, 22.6, 18, 5.4], 8, [[0, 0], [15, 0], [6, 0], [12, 0], [0, 0]]), clip: [7.6, 22.8, 20, 5] },
        blink(litLamp(25, 18, 1), lampBox(25, 18, 1), 8, [0, 0, 1, 1, 0, 0, 0, 1]),
      ];
    },
  },

  // ---------------------------------------------------------------- rare
  {
    name: "Globe", tier: 2, tmpl: T.HUB, about: "Motorised desk globe, 1 rpm. 1974 political map.",
    layers: () => {
      const c = [40, 37], R = 14.5;
      const land = (ox) => [
        "M2 31L5 28 9 27 12 29 14 28 16 31 14 34 15 38 12 42 10 46 8 44 7 40 4 37 3 34Z",
        "M20 26L24 24 28 25 31 27 29 30 26 30 27 33 24 35 22 33 21 30Z",
        "M30 38L34 36 38 37 41 40 40 44 37 47 34 46 32 43Z",
        "M41 27L44 25 47 26 48 29 45 31 42 30Z",
        "M10 24L12 23 13 25 11 26Z",
      ].map((d) => path(d.replace(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g, (_, x, y) => `${r1(+x + ox + 14)} ${r1(+y - 0.5)}`), { fill: MID, opacity: 0.9 })).join("");
      return [
        still(module(9) + label(27, 6.6, 14) + area("globe", c[0] - 22, c[1] - 22, 44, 44) + circle(...c, 22, { fill: JACK }) + circle(...c, 20.5, { fill: SCREEN }) + circle(...c, R, { fill: "#0e2414" })
          + knob(18, 69, 3.2, -30) + knob(28, 69, 3.2, 50) + lamp(38, 69, 1.1)),
        { svg: land(0) + land(48), box: [14, 21, 100, 32], clip: [...c, R], anim: { dur: 14, ease: "lin", move: [[0, 0], [-48, 0]] } },
        still(line(`M${c[0] - R + 0.6} ${c[1] - 7}H${c[0] + R - 0.6}M${c[0] - R} ${c[1]}H${c[0] + R}M${c[0] - R + 0.6} ${c[1] + 7}H${c[0] + R - 0.6}`, LIT, 0.35, { opacity: 0.3 })
          + path(`M${c[0]} ${c[1] - R}A${R} ${R} 0 0 1 ${c[0]} ${c[1] + R}A${R * 0.55} ${R} 0 0 0 ${c[0]} ${c[1] - R}Z`, { fill: "#000", opacity: 0.4 })
          + glow(ring(...c, R, LIT, 0.8)) + ring(...c, 18.5, MID, 0.45, { "stroke-dasharray": "1.2 2.2", opacity: 0.7 })
          + path(`M${pt(c[0] - 9, c[1] - 9)}A13 13 0 0 1 ${pt(c[0] - 2, c[1] - 12.6)}`, { fill: "none", stroke: "#fff", "stroke-width": 0.7, "stroke-linecap": "round", opacity: 0.35 })),
        spin(glow(circle(c[0], c[1] - 18.5, 1.3, { fill: PALE })), ...c, 20, 6),
        blink(litLamp(38, 69, 1.1), lampBox(38, 69, 1.1), 6, [1, 0, 0, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Spectrum", tier: 2, tmpl: T.BAR3, pips: [14, 32.6], about: "Spectrum analyser, 16 bands. Gain at maximum.",
    layers: () => {
      const rnd = lcg(42), S0 = [12.5, 12.5, 95, 14];
      let seg = "";
      for (let y = S0[1] + 2; y < S0[1] + S0[3]; y += 2) seg += `M${S0[0]} ${r1(y)}H${S0[0] + S0[2]}`;
      return [
        still(module(7) + screen(...S0) + knob(73, 32.6, 2.4, -40) + knob(82, 32.6, 2.4, 20) + knob(91, 32.6, 2.4, 70)),
        ...Array.from({ length: 12 }, (_, i) => {
          const hs = Array.from({ length: 5 }, () => 2 + 2 * Math.round(rnd() * 7));
          const x = 15 + i * 7.7;
          return { ...slide(glow(rect(x, S0[1], 5.4, S0[3], { fill: i < 9 ? LIT : PALE })), [x, S0[1], 5.4, S0[3] + 18], 0.7 + rnd() * 0.8, [...hs, hs[0]].map((h) => [0, h]), 0, "step"), clip: S0 };
        }),
        still(line(seg, SCREEN, 0.7)),
      ];
    },
  },
  {
    name: "Seismograph", tier: 2, tmpl: T.ELL, pips: [9.5, 32.6], about: "Drum seismograph, ink pen. One turn per hour.",
    layers: () => {
      // the paper runs right to left under a pen at x = 60; ink exists only where the pen has already been
      const P = { x: 12, y: 10.5, w: 56, h: 18.5 }, PEN = 60, mid = P.y + P.h / 2, a = 4.2, per = 28, dur = 3.5;
      let gx = "", holes = "";
      for (let x = 0; x < P.x + P.w + per; x += 3.5) gx += `M${r1(x)} ${P.y + 2.4}V${P.y + P.h - 2.4}`;
      for (let x = 1.75; x < P.x + P.w + per; x += 3.5) holes += circle(x, P.y + 1.2, 0.45, { fill: SCREW }) + circle(x, P.y + P.h - 1.2, 0.45, { fill: SCREW });
      // the trace: phase 0 at the pen, so the pen's height below matches the ink it leaves
      const trace = sine(PEN - 2 * per - 4 * per, PEN + per, mid, a, per);
      const pen = Array.from({ length: 13 }, (_, i) => [0, -a * Math.sin((2 * Math.PI * i) / 12)]);
      let rails = "";
      for (let y = 40; y <= 58; y += 3) rails += `M56.2 ${y}H57.6`;
      return [
        still(module(8) + area("paper", P.x, P.y, P.w, P.h) + rect(P.x, P.y, P.w, P.h, { fill: PAPER }) + line(`M${P.x} ${r1(mid - 5.25)}H${P.x + P.w}M${P.x} ${mid}H${P.x + P.w}M${P.x} ${r1(mid + 5.25)}H${P.x + P.w}`, "#c9c9c3", 0.35)
          + area("rail", 55, 31, 10, 30) + rect(59.3, 31, 1.4, 30, { fill: DIM }) + line(rails, DIM, 0.6)
          + area("coil", 50, 63.5, 20, 3.5) + rect(50, 63.5, 20, 3.5, { fill: INK, rx: 0.8 }) + knob(49, 46, 3, 30) + area("lamp", 69.2, 44.2, 3.6, 3.6) + circle(71, 46, 1.3, { fill: OFF, stroke: INK, "stroke-width": 0.6 })),
        { svg: line(gx, "#c9c9c3", 0.35) + holes, box: [0, P.y, P.x + P.w + per, P.h], clip: [P.x, P.y, P.w, P.h], anim: { dur, ease: "lin", move: [[0, 0], [-per, 0]] } },
        { svg: line(trace, INK, 0.9, { "stroke-linejoin": "round" }), box: [PEN - 6 * per - 4, P.y, 7 * per + 4, P.h], clip: [P.x, P.y, PEN - P.x, P.h], anim: { dur, ease: "lin", move: [[0, 0], [-per, 0]] } },
        still(line(`M${P.x} ${P.y}H${P.x + P.w}M${P.x} ${P.y + P.h}H${P.x + P.w}`, INK, 1)),
        slide(rect(59.5, mid, 1, 22, { fill: INK }) + circle(PEN, mid, 1.1, { fill: RED, stroke: INK, "stroke-width": 0.4 }) + rect(57, mid + 21, 6, 3.6, { fill: SCREW, stroke: INK, "stroke-width": 0.7, rx: 0.5 }), [56, mid - a - 2, 8, 36], dur, pen, 0, "lin"),
        blink(glow(circle(71, 46, 1.3, { fill: LIT })), [69, 44, 4, 4], dur, [0, 0, 0, 1, 0, 0, 0, 0]),
      ];
    },
  },
  {
    name: "Nixie", tier: 2, tmpl: T.CROSS, screws: false, about: "Nixie tube, digits 0–9. Warm-up 2 s.",
    layers: () => {
      let mesh = "";
      for (let y = 12.4; y < 28; y += 1.6) mesh += `M13.6 ${r1(y)}H26.4`;
      for (let x = 14.4; x < 26; x += 1.6) mesh += `M${r1(x)} 12V28`;
      const strip = slide(Array.from({ length: 10 }, (_, i) => digits(17.3, 15 + 16 * i, 1, i, LIT)).join(""), [17, 15, 6, 154], 10, Array.from({ length: 10 }, (_, i) => [0, -16 * i]), 0, "step");
      // Filter the whole digit strip before it moves into the tube: the shared glow ends at y=130.
      const [x, y, w, h] = strip.box;
      strip.svg = glowDefs("nixie-glow", [x - 10, y - 10, w + 20, h + 20]) + glow(strip.svg, "nixie-glow");
      strip.box = [x - 2.5, y - 2.5, w + 5, h + 5];
      strip.clip = [12.4, 11, 15.2, 18];
      return [
        still(module(3, { screws: false }) + area("tube", 12.4, 11, 15.2, 18) + rect(12.4, 11, 15.2, 18, { rx: 3.4, fill: "#0f1410", stroke: JACK, "stroke-width": W_LINE })
          + line(mesh, DIM, 0.2, { opacity: 0.5 }) + digits(17.3, 15, 1, null, "#17301d") + rect(14.6, 11.8, 10.8, 1, { fill: SCREW, opacity: 0.35, rx: 0.5 })),
        strip,
        still(path("M14 14Q14.2 12.4 16 12.2", { fill: "none", stroke: "#fff", "stroke-width": 0.6, opacity: 0.35 })),
      ];
    },
  },

  // ---------------------------------------------------------------- legendary
  {
    name: "Orrery", tier: 3, tmpl: T.BIGHUB, pips: [35.4, 7.4], about: "Clockwork orrery, six planets. Wind weekly.",
    layers: () => {
      const c = [40, 40], corners = [[11.2, 11.2], [68.8, 11.2], [68.8, 68.8], [11.2, 68.8]];
      return [
        still(module(10) + area("orrery", 13.6, 13.6, 52.8, 52.8) + circle(...c, 26, { fill: JACK }) + circle(...c, 24.5, { fill: SCREEN })
          + [7.5, 13, 18.5, 23].map((r) => ring(...c, r, MID, 0.4, { opacity: 0.5, "stroke-dasharray": "0.8 1.6" })).join("")
          + corners.map(([x, y]) => lamp(x, y, 1.1)).join("")),
        blink(glow(circle(...c, 4.4, { fill: LIT, opacity: 0.35 })), [34, 34, 12, 12], 2, [1, 0.5]),
        still(glow(circle(...c, 3, { fill: LIT })) + circle(c[0] - 0.9, c[1] - 0.9, 0.9, { fill: PALE })),
        spin(glow(circle(40, 32.5, 1.2, { fill: PALE })), ...c, 9, 2.4),
        spin(glow(circle(40, 27, 2, { fill: LIT })) + circle(43.4, 27, 0.6, { fill: PALE }), ...c, 15, 6.5),
        spin(path("M37 21.5A3.6 1.2 -20 0 0 43 21.5", { fill: "none", stroke: PALE, "stroke-width": 0.5 }) + glow(circle(40, 21.5, 1.8, { fill: MID })) + path("M37 21.5A3.6 1.2 -20 0 1 43 21.5", { fill: "none", stroke: PALE, "stroke-width": 0.5 }), ...c, 21, 14),
        spin(glow(circle(40, 17, 1, { fill: PALE })), ...c, 24.5, 22, 1, 0.5),
        ...corners.map(([x, y], i) => blink(litLamp(x, y, 1.1), lampBox(x, y, 1.1), 2.4, [1, 0, 0, 0], i / 4)),
      ];
    },
  },
  {
    name: "Mainframe", tier: 3, tmpl: T.REACTOR, pips: [25.5, 9], about: "Mainframe cabinet. Two tape drives, 64-lamp panel.",
    layers: () => {
      const rnd = lcg(2026);
      const lamps = [];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) lamps.push([22 + c * 8.4, 58 + r * 6]);
      const groups = Array.from({ length: 6 }, () => []);
      lamps.forEach((l) => groups[Math.floor(rnd() * 6)].push(l));
      return [
        still(module(11) + label(70, 8.2, 18) + area("window", 18, 15, 84, 34) + rect(18, 15, 84, 34, { fill: "#c9c9c4", stroke: INK, "stroke-width": W_LINE, rx: 1 })
          + [36, 84].map((x) => circle(x, 31.6, 13, { fill: INK }) + circle(x, 31.6, 9.6, { fill: "#3b3a36" })).join("")
          + line("M24.4 41.6L54 45.6H66L95.6 41.6", "#2b2a27", 0.9) + rect(54, 39, 12, 8.4, { fill: INK, rx: 0.8 }) + circle(60, 43, 1.4, { fill: SCREW })
          + area("lamps", 16, 53, 88, 28) + rect(16, 53, 88, 28, { fill: INK, rx: 1 }) + lamps.map(([x, y]) => circle(x, y, 1.7, { fill: OFF })).join("")
          + screen(28, 88.5, 64, 13) + digits(31, 90, 8, null, "#16301c") + knob(100, 95, 3.4, -45)),
        { ...spin(reelFlange(36, 31.6, 13), 36, 31.6, 13.5, 3.2), anim: { dur: 3.2, ease: "lin", rot: [36, 31.6, [0, 140, 140, 330, 360]] } },
        { ...spin(reelFlange(84, 31.6, 13), 84, 31.6, 13.5, 3.2), anim: { dur: 3.2, ease: "lin", rot: [84, 31.6, [0, 0, 200, 250, 360]] } },
        ...groups.map((g, i) => blink(glow(g.map(([x, y]) => circle(x, y, 1.7, { fill: LIT })).join("")), [18, 54, 84, 26], 1.2 + i * 0.35, Array.from({ length: 6 }, () => (rnd() < 0.3 ? 1 : 0)), i / 6)),
        live("paid", 31, 90, 8),
      ];
    },
  },
);

// the core, cells (-1, -1) .. (1, 1): twelve sockets, every machine grows from it. Drawn by the app (it is not a token).
// A phosphor screen with a lit frame and lit jacks, a range graticule and a trace running across it.
const corePulse = (x0) => `M${x0} 60H${x0 + 22}L${x0 + 27} 50 ${x0 + 32} 72 ${x0 + 37} 34 ${x0 + 42} 80 ${x0 + 47} 52 ${x0 + 51} 60H${x0 + 84}`;
const coreTrace = scroll(line(corePulse(18) + corePulse(102).replace(/^M\d+ 60/, ""), LIT, 1.6, { "stroke-linejoin": "round" }), [18, 18, 84, 84], 84, 3.2);
// Both pulses must survive filtering before the sprite scrolls into the screen window.
// Size a separate filter to the complete trace, with room for the stroke and blur.
const [traceX, traceY, traceW, traceH] = coreTrace.box;
coreTrace.svg = glowDefs("core-glow", [traceX - 10, traceY - 10, traceW + 20, traceH + 20]) + glow(coreTrace.svg, "core-glow");
const CORE = [
  still(module(CORE_CELLS, { screws: false, face: SCREEN, border: LIT }) + fittings(CORE_CELLS, LIT)
    + grid("M18 60H102M60 18V102M18 39H102M18 81H102M39 18V102M81 18V102")
    + rect(18, 18, 84, 84, { fill: "none", stroke: MID, "stroke-width": 0.8, opacity: 0.6 })
    + ring(60, 60, 30, MID, 0.6, { opacity: 0.35 })),
  coreTrace,
];

// ------------------------------------------------------------------ build

function build(p, id) {
  REG = [];
  const layers = p.layers();
  let top = fittings(p.tmpl, p.jack);
  if (p.pips !== false) top += pips(...(p.pips ?? pipSpot(p.tmpl, p.screws !== false)), p.tier === 4 ? 0 : p.tier + 1, 0.9, 2.4);
  layers.push(still(top));
  if (REG) {
    const bad = overlaps(REG);
    if (bad.length) throw new Error(`${p.name}: overlapping elements: ${bad.join(", ")}`);
  }
  REG = null;
  // glowing moving layers need room for the blur in their bitmap
  for (const l of layers) if (l.box && l.svg.includes("url(#glow)")) l.box = [l.box[0] - 2.5, l.box[1] - 2.5, l.box[2] + 5, l.box[3] + 5];
  const { w, h } = bbox(p.tmpl);
  const W = w * C, H = h * C;
  let clips = 0;
  const art = layers.map((l) => {
    if (!l.anim) return l.svg;
    const g = `<g>${l.svg}${smil(l.anim)}</g>`;
    if (!l.clip) return g;
    const cid = `p${id}c${clips++}`;
    return `<clipPath id="${cid}">${l.clip.length === 3 ? circle(...l.clip) : rect(...l.clip)}</clipPath><g clip-path="url(#${cid})">${g}</g>`;
  }).join("");
  const lv = layers.find((l) => l.live)?.live;
  const pad = 6;
  const defs = art.includes("url(#glow)") ? GLOW_DEFS : "";
  const chain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}">${defs}<rect x="${-pad}" y="${-pad}" width="${W + 2 * pad}" height="${H + 2 * pad}" fill="${BG}"/>${art}</svg>`;
  if (/['\\]|[^\x20-\x7e]/.test(chain)) throw new Error(`${p.name}: art must be printable ASCII without ' or \\`);
  if (chain.split("@@").length !== (lv ? 2 : 1)) throw new Error(`${p.name}: "@@" is reserved for one live layer`);
  // what a fresh machine serves: live values are 0
  const svg = lv ? chain.replace("@@", digits(lv.x, lv.y, lv.n, 0, LIT)) : chain;
  return { id, name: p.name, tier: p.tier, tmpl: p.tmpl, about: p.about, w, h, svg, chain, live: lv, layers };
}

// every slot that can be rolled (Shapes.dropOdds) has at least one part, and no part sits in any other slot
const SLOTS = { 0: [0, 1, 2, 3, 4, 5], 1: [1, 2, 3, 5, 6], 2: [3, 7, 8, 9], 3: [10, 11], 4: [3] }; // Shapes.dropOdds > 0
const BUILT = PARTS.map(build);
for (const [tier, ts] of Object.entries(SLOTS)) for (const t of ts) if (!BUILT.some((p) => p.tier === +tier && p.tmpl === t)) throw new Error(`slot ${tier}:${t} is empty`);
for (const p of BUILT) if (!SLOTS[p.tier].includes(p.tmpl)) throw new Error(`${p.name}: slot ${p.tier}:${p.tmpl} is never rolled`);
if (BUILT.filter((p) => p.tier === 4).length !== 1) throw new Error("exactly one Agent Core");

const out = (rel, s) => {
  const f = join(ROOT, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, s);
};
const HEAD = "// SPDX-License-Identifier: MIT\n// GENERATED by art/parts.mjs. Do not edit by hand.\npragma solidity ^0.8.26;\n\n";
const hex = (a) => a.map((v) => v.toString(16).padStart(2, "0")).join("");
if (BUILT.length > 255) throw new Error("slotParts stores part ids in one byte");

out("src/art/Catalog.sol", HEAD +
`/// @notice The fixed part catalog. Each (rarity, template) slot holds one or more parts; part ids are design ids.
library Catalog {
    uint16 internal constant COUNT = ${BUILT.length};
    uint16 internal constant AGENT_CORE = ${BUILT.findIndex((p) => p.tier === 4)};

    bytes internal constant TIER = hex"${hex(BUILT.map((p) => p.tier))}";
    bytes internal constant TMPL = hex"${hex(BUILT.map((p) => p.tmpl))}";

    error NoSuchPart();

    function tierOf(uint256 id) internal pure returns (uint8) {
        if (id >= COUNT) revert NoSuchPart();
        return uint8(TIER[id]);
    }

    function tmplOf(uint256 id) internal pure returns (uint8) {
        if (id >= COUNT) revert NoSuchPart();
        return uint8(TMPL[id]);
    }

    /// @notice One of the parts in slot (tier, tmpl), chosen by x, each equally likely. Every slot with
    ///         non-zero odds in Shapes has at least one part.
    function partFor(uint8 tier, uint8 tmpl, uint256 x) internal pure returns (uint16) {
        bytes memory ids = slotParts(tier, tmpl);
        if (ids.length == 0) revert NoSuchPart();
        return uint8(ids[x % ids.length]);
    }

    /// @notice How many parts share slot (tier, tmpl).
    function slotSize(uint8 tier, uint8 tmpl) internal pure returns (uint256) {
        return slotParts(tier, tmpl).length;
    }

    /// @notice The part ids in slot (tier, tmpl), one byte each.
    function slotParts(uint8 tier, uint8 tmpl) internal pure returns (bytes memory) {
        uint256 k = (uint256(tier) << 8) | tmpl;
${Object.entries(SLOTS).flatMap(([tier, ts]) => ts.map((t) => `        if (k == ${(+tier << 8) | t}) return hex"${hex(BUILT.filter((p) => p.tier === +tier && p.tmpl === t).map((p) => p.id))}";`)).join("\n")}
        return "";
    }
}
`);

const withDefs = (svg) => (svg.includes("url(#glow)") ? GLOW_DEFS + svg : svg);
const appLayers = (layers) => layers.map((l) => (l.live ? { svg: "", live: l.live } : l.anim ? { svg: withDefs(l.svg), box: l.box, ...(l.clip ? { clip: l.clip } : {}), anim: l.anim } : { svg: withDefs(l.svg) }));
const appParts = BUILT.map(({ id, name, tier, tmpl, about, w, h, svg, layers }) => ({
  id, name, tier, tmpl, about, w, h, svg,
  layers: appLayers(layers),
}));
out("app/src/parts.gen.ts",
`// GENERATED by art/parts.mjs. Do not edit by hand.
// Units: one grid cell = ${C}. Moving layers: { box: [x, y, w, h], clip?: [x, y, w, h], anim: { dur, ease, phase?, rot?: [cx, cy, deg[]], move?: [x, y][], fade?: number[] } }.
// ease "step" holds each keyframe for an equal share of the cycle.

export interface Anim { dur: number; ease: "lin" | "sin" | "step"; phase?: number; rot?: [number, number, number[]]; move?: [number, number][]; fade?: number[] }
/** clip: a rectangle [x, y, w, h] or a circle [cx, cy, r]. live: seven-segment digits drawn from machine state. */
export interface Layer { svg: string; box?: [number, number, number, number]; clip?: number[]; anim?: Anim; live?: { kind: "minted" | "paid"; x: number; y: number; n: number } }
/** svg: the full animated SVG the chain serves */
export interface PartDef { id: number; name: string; tier: number; tmpl: number; about: string; w: number; h: number; svg: string; layers: Layer[] }

export const UNIT = ${C};
/** templates: cells in rotation 0 as [dx, dy, sockets] (must match src/Shapes.sol; tested there) */
export const TEMPLATES: [number, number, number][][] = ${JSON.stringify(TEMPLATES)};
/** seven-segment geometry in tenths of a unit (shared with the canvas renderer): [dx, dy, w, h] per segment a..g */
export const SEG = ${JSON.stringify(SEG)};
export const DIGIT = ${JSON.stringify(DIGIT)};
export const PARTS: PartDef[] = ${JSON.stringify(appParts)};
export const CORE: Layer[] = ${JSON.stringify(appLayers(CORE))};
/** the core's cells (IdentityMachine._cell), drawn at (-1, -1) .. (1, 1) */
export const CORE_CELLS: [number, number, number][] = ${JSON.stringify(CORE_CELLS.map(([x, y, m]) => [x - 1, y - 1, m]))};
`);

for (const p of BUILT) out(`art/out/${p.id}.svg`, p.svg);
// the templates the art was drawn for; test/Machine.t.sol checks them against Shapes.sol
out("art/out/templates.json", JSON.stringify(TEMPLATES.map((cells) => ({ n: cells.length, dx: cells.map((c) => c[0]), dy: cells.map((c) => c[1]), m: cells.map((c) => c[2]) }))));

const TIERS = ["Common", "Uncommon", "Rare", "Legendary", "Agent Core"];
// a small machine made of the parts, wired by the real rules, to judge them together the way they appear on the board
// placed greedily by the real rules (IdentityMachine._check): each part plugs into the open socket closest to the core
const DEMO_ORDER = [40, 3, 26, 36, 9, 30, 31, 35, 18, 28, 38, 34, 39, 37, 24, 21, 32, 17, 33, 23, 25, 29, 19, 27, 20, 22];
const rotMask = (m, r) => { for (let i = 0; i < r; i++) m = ((m << 1) | (m >> 3)) & 15; return m; };
function rotCell(dx, dy, r) { for (let i = 0; i < r; i++) [dx, dy] = [-dy, dx]; return [dx, dy]; }
const DIRS = [[N, 0, -1], [E, 1, 0], [S, 0, 1], [W, -1, 0]];
const opp = (d) => (d === N ? S : d === S ? N : d === E ? W : E);
function layoutDemo() {
  const cells = new Map(CORE_CELLS.map(([x, y, m]) => [`${x - 1},${y - 1}`, { m, core: true }]));
  const placed = [];
  const fp = (tmpl, rot, x, y) => TEMPLATES[tmpl].map(([dx, dy, m]) => { const [rx, ry] = rotCell(dx, dy, rot); return [x + rx, y + ry, rotMask(m, rot)]; });
  const fits = (tmpl, rot, x, y) => {
    const f = fp(tmpl, rot, x, y), mine = new Set(f.map(([a, b]) => `${a},${b}`));
    if (f.some(([a, b]) => cells.has(`${a},${b}`))) return false;
    let links = 0;
    for (const [a, b, m] of f) for (const [d, vx, vy] of DIRS) {
      const k = `${a + vx},${b + vy}`;
      if (mine.has(k) || !cells.has(k)) continue;
      const mineS = !!(m & d), theirs = !!(cells.get(k).m & opp(d));
      if (mineS !== theirs) return false;
      if (mineS) links++;
    }
    return links > 0;
  };
  for (const id of DEMO_ORDER) {
    const tmpl = BUILT[id].tmpl;
    let best = null;
    const spots = [];
    for (let x = -8; x <= 8; x++) for (let y = -8; y <= 8; y++) for (let rot = 0; rot < 4; rot++) if (fits(tmpl, rot, x, y)) {
      const f = fp(tmpl, rot, x, y);
      const cx = f.reduce((s, c) => s + c[0], 0) / f.length, cy = f.reduce((s, c) => s + c[1], 0) / f.length;
      spots.push({ rot, x, y, d: Math.hypot(cx, cy * 1.6) + rot * 0.01 });
    }
    spots.sort((p, q) => p.d - q.d);
    best = spots[0];
    if (!best) continue;
    for (const [a, b, m] of fp(tmpl, best.rot, best.x, best.y)) cells.set(`${a},${b}`, { m });
    placed.push([id, best.rot, best.x, best.y]);
  }
  return placed;
}
const DEMO = layoutDemo();
function demo() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, body = "";
  for (const [id, rot, x, y] of DEMO) {
    const p = BUILT[id];
    const cells = TEMPLATES[p.tmpl].map(([dx, dy]) => rotCell(dx, dy, rot)).map(([dx, dy]) => [x + dx, y + dy]);
    const mx = Math.min(...cells.map((c) => c[0])), my = Math.min(...cells.map((c) => c[1]));
    for (const [cx, cy] of cells) { x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx + 1); y1 = Math.max(y1, cy + 1); }
    const bw = (rot % 2 ? p.h : p.w) * C, bh = (rot % 2 ? p.w : p.h) * C;
    // Strip the wrapper, shared glow and background; keep filters scoped to individual layers.
    const inner = p.svg.replace(/^<svg[^>]*>/, "").replace(GLOW_DEFS, "").replace(/^<rect[^>]*\/>/, "").replace(/<\/svg>$/, "");
    if (inner.includes("<svg")) throw new Error(`${p.name}: could not unwrap for the demo`);
    body += `<g transform="translate(${mx * C + bw / 2} ${my * C + bh / 2}) rotate(${rot * 90}) translate(${-p.w * C / 2} ${-p.h * C / 2})">${inner}</g>`;
  }
  body += `<g transform="translate(${-C} ${-C})">${CORE.map((l) => (l.anim ? `<g>${l.svg}${smil(l.anim)}</g>` : l.svg)).join("")}</g>`;
  x0 = Math.min(x0, -1); y0 = Math.min(y0, -1); x1 = Math.max(x1, 2); y1 = Math.max(y1, 2);
  const pad = 20;
  const W = (x1 - x0) * C + 2 * pad, H = (y1 - y0) * C + 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" style="max-width:100%;height:auto" viewBox="${x0 * C - pad} ${y0 * C - pad} ${W} ${H}">${GLOW_DEFS}${body}</svg>`;
}

const TIER_LABEL = ["Common", "Uncommon", "Rare", "Legendary", "Agent Core"];
out("art/preview.html", `<!doctype html><html><head><meta charset="utf-8"><title>Identity Machine parts</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>body{margin:0;padding:28px 34px;background:#000;color:#fff;font:13px/1.6 "IBM Plex Mono",ui-monospace,monospace}
h1{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:0 0 4px}h2{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:36px 0 14px;color:#9a9a9a}
p.sub{color:#9a9a9a;margin:0}.grid{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-end}figure{margin:0;display:flex;flex-direction:column;gap:10px}
figure svg{display:block}figcaption{font-size:12px;line-height:1.5}figcaption em{font-style:normal;color:#9a9a9a;display:block;font-size:11px;max-width:220px}
figcaption b{font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:11px}</style></head>
<body><h1>Identity Machine parts</h1><p class="sub">${BUILT.length} parts, ${(BUILT.reduce((s, p) => s + p.svg.length, 0) / 1024).toFixed(1)} KiB of SVG</p>
<h2>Assembled</h2>${demo()}
<h2>Every part</h2>
<div class="grid">${BUILT.map((p) => `<figure>${p.svg.replace("<svg ", `<svg width="${(p.w * C + 12) * 3}" height="${(p.h * C + 12) * 3}" `)}<figcaption><b>${p.name}</b><em>${TIER_LABEL[p.tier]}, ${p.w}×${p.h} cells</em><em>${p.about}</em></figcaption></figure>`).join("")}</div></body></html>
`);

console.log(`${BUILT.length} parts`);
for (const p of BUILT) console.log(`  ${String(p.id).padStart(2)} ${p.name.padEnd(11)} ${TIER_LABEL[p.tier].padEnd(10)} ${p.svg.length} B`);
