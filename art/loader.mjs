// Approved application loader. Run: node art/loader.mjs
// Three solid parts share four bays. The leading edge docks before the tail retracts.
// Geometry changes along the direction of travel; the cross-section and corner radius stay fixed.
import { writeFileSync } from "node:fs";

const unit = 18, pitch = 20, inset = 2, radius = .7;
const bays = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) =>
  [inset + x * pitch, inset + y * pitch, inset + x * pitch + unit, inset + y * pitch + unit]);
const fills = ["#d6d6d2", "#a8ada3", "#596154"];
const number = n => Number(n.toFixed(3));
const path = ([x, y, right, bottom]) => {
  const r = radius;
  return `M ${number(x + r)} ${number(y)} H ${number(right - r)} Q ${number(right)} ${number(y)} ${number(right)} ${number(y + r)} V ${number(bottom - r)} Q ${number(right)} ${number(bottom)} ${number(right - r)} ${number(bottom)} H ${number(x + r)} Q ${number(x)} ${number(bottom)} ${number(x)} ${number(bottom - r)} V ${number(y + r)} Q ${number(x)} ${number(y)} ${number(x + r)} ${number(y)} Z`;
};
const position = [0, 1, 2];
const frames = bays.slice(0, 3).map(bounds => [{ at: 0, bounds }]);
const moves = [];
let clock = .10;
for (let i = 0; i < 12; i++) {
  const piece = 2 - i % 3;
  const from = position[piece], to = (from + 1) % 4;
  const start = bays[from], end = bays[to];
  const extended = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[2], end[2]), Math.max(start[3], end[3])];
  const dock = clock + .22;
  const retract = dock + .025;
  const finish = retract + .20;
  frames[piece].push(
    { at: clock, bounds: start, ease: "cubic-bezier(.55,0,.18,1)" },
    { at: dock, bounds: extended },
    { at: retract, bounds: extended, ease: "cubic-bezier(.32,0,.16,1)" },
    { at: finish, bounds: end },
  );
  moves.push({ piece, from, to, start: number(clock), dock: number(dock), finish: number(finish) });
  position[piece] = to;
  clock = finish + .065 + (i % 4 === 3 ? .085 : 0);
}
if (position.some((p, i) => p !== i)) throw Error("The loop must restore every part.");
const duration = number(clock);
const styles = [
  `path { animation: var(--motion) ${duration}s linear infinite; }`,
  "@media (prefers-reduced-motion: reduce) { path { animation: none; } }",
];
for (let i = 0; i < 3; i++) {
  frames[i].push({ at: duration, bounds: bays[i] });
  const keyframes = frames[i].map(({ at, bounds, ease }) =>
    `    ${number(at / duration * 100)}% { d: path("${path(bounds)}");${ease ? ` animation-timing-function: ${ease};` : ""} }`);
  styles.push(`@keyframes part-${i} {\n${keyframes.join("\n")}\n}`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 42 42" role="img" aria-labelledby="title desc">
  <title id="title">Plugging parts</title>
  <desc id="desc">Three gray parts extend into an empty space, then draw their trailing edge in, one after another.</desc>
  <style>
${styles.join("\n")}
  </style>
${fills.map((fill, i) => `  <path id="part-${i}" style="--motion:part-${i}" fill="${fill}" d="${path(bays[i])}"/>`).join("\n")}
</svg>
`;
writeFileSync(new URL("../app/public/parts-loader.svg", import.meta.url), svg);
writeFileSync(new URL("../app/public/parts-loader-static.svg", import.meta.url), svg.replace(/  <style>[\s\S]*?<\/style>\n/, ""));
console.log(JSON.stringify({ duration, bays, moves, parts: 3, bytes: Buffer.byteLength(svg) }));
