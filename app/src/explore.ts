// Exploring a machine from the Archive part by part: its placements are read from MachineViews.board and drawn by
// the same renderer as the live machine. Drag to pan, scroll or pinch to zoom, tap a part for who placed it, when,
// and how it is wired.
import { Board, TIER_CLASS } from "./geometry";
import { rarityTag } from "./rarity";
import { Renderer } from "./render";
import { Store, short, same, boardEntry } from "./store";
import { PLACES } from "./econ";

const ordinal = (n: number) => n.toLocaleString() + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
const PAGE = 800; // parts per board() call, as the live page reads them
const ZMIN = 0.12, ZMAX = 6;

/** frame the whole machine (core included) in the renderer's canvas */
export function fitBoard(R: Renderer, B: Board, margin = 0.92) {
  let x0 = -2, y0 = -2, x1 = 3, y1 = 3;
  for (const p of B.parts.values()) {
    if (!p.placed) continue;
    x0 = Math.min(x0, p.x - 1); y0 = Math.min(y0, p.y - 1); x1 = Math.max(x1, p.x + 3); y1 = Math.max(y1, p.y + 3);
  }
  const r = R.canvas.getBoundingClientRect();
  R.cam.z = Math.min(2.2, Math.max(ZMIN, margin * Math.min(r.width / ((x1 - x0) * R.cell), r.height / ((y1 - y0) * R.cell))));
  R.cam.x = (x0 + x1) / 2;
  R.cam.y = (y0 + y1) / 2;
}

/** a machine's placements from MachineViews.board, a page at a time; `each` sees every part with its build order */
export async function loadBoard(S: Store, B: Board, round: number, placed: number, each?: (id: number, k: number) => void,
  more: () => boolean = () => true, progress?: (done: number) => void) {
  for (let from = 1; from <= placed && more(); from += PAGE) {
    progress?.(from - 1);
    const words = (await S.readViews("board", [BigInt(round), BigInt(from), BigInt(PAGE)])) as bigint[];
    for (let k = 0; k < words.length / 2; k++) {
      const p = boardEntry(words[2 * k], words[2 * k + 1]);
      B.upsert({ id: p.id, owner: p.placer, design: p.design, plug: 0n });
      if (!B.parts.get(p.id)!.placed) B.place(p.id, p.rot, p.x, p.y);
      each?.(p.id, from + k);
    }
  }
}

export function explore(S: Store, round: number, placed: number, running = false) {
  const last = document.activeElement as HTMLElement | null;
  const el = document.createElement("div");
  el.className = "explore";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", `Machine #${round}`);
  el.innerHTML = `<header class="explore-head"><h2>Machine #${round}</h2><span class="explore-sub"></span>
      <button type="button" class="explore-x" aria-label="Close">×</button></header>
    <div class="explore-stage"><canvas aria-label="Machine #${round}. Drag to move, scroll or pinch to zoom, tap a part."></canvas>
      <p class="explore-loading hint" role="status"></p>
      <div class="explore-info" hidden aria-live="polite"></div>
      <div class="explore-zoom"><button type="button" data-z="1.25" aria-label="Zoom in">+</button><button type="button" data-z="0.8" aria-label="Zoom out">−</button><button type="button" data-z="fit" aria-label="Whole machine">▣</button></div>
    </div>`;
  document.body.append(el);
  document.body.classList.add("exploring");
  const canvas = el.querySelector("canvas")!, info = el.querySelector<HTMLElement>(".explore-info")!;
  const loading = el.querySelector<HTMLElement>(".explore-loading")!;
  el.querySelector(".explore-sub")!.textContent = `${placed.toLocaleString()} ${placed === 1 ? "part" : "parts"}`;

  const B = new Board();
  B.round = round;
  const R = new Renderer(canvas, B, false);
  R.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  R.me = S.me;
  R.resize();
  const order = new Map<number, number>(); // part → its place in the build order (1 = first placed)
  let open = true, frame = 0;

  // ---------------------------------------------------------------- loading
  (async () => {
    let first = true;
    await loadBoard(S, B, round, placed, (id, k) => order.set(id, k), () => open, (done) => {
      loading.textContent = `Loading ${done.toLocaleString()} / ${placed.toLocaleString()} parts…`;
      if (done > 0 && first) { first = false; fit(); } // frame the first page while the rest loads
    });
    loading.hidden = true;
    fit();
  })().catch(() => (loading.textContent = "Couldn't load this machine. Try again later."));

  // ---------------------------------------------------------------- camera
  function fit() {
    fitBoard(R, B);
  }
  function zoomAt(sx: number, sy: number, z: number) {
    const [wx, wy] = R.toWorld(sx, sy);
    R.cam.z = Math.min(ZMAX, Math.max(ZMIN, z));
    const [nx, ny] = R.toWorld(sx, sy);
    R.cam.x += wx - nx;
    R.cam.y += wy - ny;
  }

  // ---------------------------------------------------------------- picking a part
  function pick(id: number | null) {
    R.hover = id;
    if (id === null || id === 0) {
      info.hidden = id === null;
      delete info.dataset.tier;
      if (id === 0) info.innerHTML = `<b>Core</b><span>Where every machine starts: twelve sockets.</span>`;
      return;
    }
    const p = B.parts.get(id)!, d = B.designs.get(p.design)!, k = order.get(id) ?? 0;
    info.dataset.tier = TIER_CLASS[d.tier];
    const fromEnd = placed - k; // 0 = the last part placed: first place
    const prize = fromEnd < PLACES.length ? `<span class="prize">Prize place ${fromEnd + 1}${running ? " if the round ends now" : ""}</span>` : "";
    info.hidden = false;
    info.innerHTML = `<span class="tip-head"><b>${d.name} #${id}</b>${rarityTag(d.tier)}</span>
      <span>Placed by ${same(p.owner, S.me) ? "you" : short(p.owner)}</span>
      <span>Placed ${ordinal(k)} of ${placed.toLocaleString()}</span>
      <span>${B.links(id).length} of ${B.socketCount(id)} sockets plugged</span>${prize}`;
    R.pulse(id);
  }

  // ---------------------------------------------------------------- pointer, wheel, keys
  const pointers = new Map<number, [number, number]>();
  let pan: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  let pinch: { d: number; z: number } | null = null;
  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: R.cam.z };
      pan = null;
    } else pan = { x: e.clientX, y: e.clientY, cx: R.cam.x, cy: R.cam.y, moved: false };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], r = canvas.getBoundingClientRect();
      zoomAt((a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top, (pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d);
      return;
    }
    if (pan) {
      if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 4) pan.moved = true;
      if (pan.moved) {
        R.cam.x = pan.cx - (e.clientX - pan.x) / R.cs;
        R.cam.y = pan.cy - (e.clientY - pan.y) / R.cs;
      }
    } else if (e.pointerType === "mouse") {
      canvas.style.cursor = R.partAt(...R.toWorld(...local(e))) !== null ? "pointer" : "grab";
    }
  });
  const release = (e: PointerEvent) => {
    if (pan && !pan.moved && !pinch) pick(R.partAt(...R.toWorld(...local(e))));
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); pan = pinch = null; });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
    zoomAt(...local(e), R.cam.z * Math.exp(-delta * 0.0015));
  }, { passive: false });
  el.querySelectorAll<HTMLButtonElement>(".explore-zoom button").forEach((b) => (b.onclick = () => {
    if (b.dataset.z === "fit") return fit();
    const r = canvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, R.cam.z * Number(b.dataset.z));
  }));
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      // keep focus inside the dialog
      const f = [...el.querySelectorAll<HTMLElement>("button")];
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener("keydown", keys);
  const resize = new ResizeObserver(() => R.resize());
  resize.observe(canvas);

  const loop = (t: number) => {
    if (!open) return;
    R.frame(t, !!pan?.moved || !!pinch);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  function close() {
    open = false;
    cancelAnimationFrame(frame);
    resize.disconnect();
    document.removeEventListener("keydown", keys);
    document.body.classList.remove("exploring");
    el.remove();
    last?.focus();
  }
  el.querySelector<HTMLButtonElement>(".explore-x")!.onclick = close;
  el.querySelector<HTMLButtonElement>(".explore-x")!.focus();
  return { close, board: B, renderer: R };
}
