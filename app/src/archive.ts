// The Archive: every machine, newest first, each drawn with the game's own renderer from MachineViews.board as it
// scrolls into view (animated only while visible). Explore opens a machine part by part (explore.ts).
import { Store, short, same } from "./store";
import { explore, fitBoard, loadBoard } from "./explore";
import { Board } from "./geometry";
import { Renderer } from "./render";
import { shell, wallet } from "./shell";
import { fmt } from "./econ";
import { money } from "./usd";
import { toast } from "./ui";
import { PARTS } from "./parts.gen";

shell("Archive");
const S = new Store({ board: false });
const PAGE = 24;
const disposers = new Set<() => void>();
let loadVersion = 0, nextRound = 0, loadingPage = false;
let loadedKey = "";
const root = document.getElementById("machines")!;
const earlier = document.createElement("button");
earlier.type = "button";
earlier.className = "btn outline";
earlier.textContent = "Load earlier machines";
earlier.hidden = true;
root.after(earlier);
earlier.onclick = () => loadPage(loadVersion).catch(e => toast(`Couldn't load earlier machines: ${e.message}`, "bad"));

interface Info { begin: bigint; deadline: bigint; ended: bigint; minted: bigint; placed: bigint; open: bigint; pot: bigint; prize: bigint }

/** the machine in the card, drawn like the live board; it animates only while on screen */
async function drawMachine(pic: HTMLElement, round: number, placed: number): Promise<() => void> {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Machine #${round}`);
  const B = new Board();
  B.round = round;
  await loadBoard(S, B, round, placed, undefined, () => pic.isConnected);
  if (!pic.isConnected) return () => {};
  pic.replaceChildren(canvas);
  const R = new Renderer(canvas, B, false);
  R.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  R.me = S.me;
  R.resize();
  fitBoard(R, B, 0.86);
  let visible = false, raf = 0;
  const loop = (t: number) => {
    raf = 0;
    if (!visible || !canvas.isConnected) return;
    R.frame(t);
    raf = requestAnimationFrame(loop);
  };
  const visibility = new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    if (visible && !raf) raf = requestAnimationFrame(loop);
  });
  visibility.observe(canvas);
  const resize = new ResizeObserver(() => { R.resize(); fitBoard(R, B, 0.86); });
  resize.observe(canvas);
  return () => { visible = false; cancelAnimationFrame(raf); visibility.disconnect(); resize.disconnect(); };
}

const hours = (a: bigint, b: bigint) => Math.max(0, Number(b - a) / 3600);
const when = (t: bigint) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function card(round: number, m: Info, running: boolean): HTMLElement {
  const el = document.createElement("article");
  el.className = "card machine-card";
  const end = running ? BigInt(Math.floor(Date.now() / 1000 + S.offset)) : m.ended;
  const how = running ? "Running" : "Clock";
  el.innerHTML = `<div class="pic"><span class="hint">Drawing…</span></div>
    <div class="meta">
      <div class="name">Machine #${round}<em class="${running ? "live" : ""}">${how}</em></div>
      <dl>
        <dt>Parts</dt><dd>${Number(m.placed).toLocaleString()}</dd>
        <dt>Mints</dt><dd>${Number(m.minted).toLocaleString()}</dd>
        <dt>${running ? "Pot" : "Pot / paid"}</dt><dd class="pot"></dd>
        <dt>Started</dt><dd>${when(m.begin)}</dd>
        <dt>${running ? "Running" : "Lasted"}</dt><dd>${hours(m.begin, end).toFixed(1)} h</dd>
        <dt>First place</dt><dd class="first">–</dd>
      </dl>
      ${!running && m.placed === 0n ? `<p class="hint">Nothing placed.</p>` : ""}
      ${m.placed > 0n ? `<button type="button" class="btn sm machine-explore">Explore ${running ? "this machine" : `machine #${round}`}</button>` : ""}
    </div>`;
  const pot = el.querySelector<HTMLElement>(".pot")!;
  if (running) money(pot, m.pot);
  else pot.textContent = `${fmt(m.pot)} / ${fmt(m.prize)} IMD`;
  // The authoritative prize order: the round's last ten placements.
  if (m.placed > 0n) {
    S.read("leaders", [BigInt(round)]).then(async (leaders: bigint[]) => {
      if (!leaders.length) return;
      const id = leaders[0];
      const [p, placer] = await Promise.all([S.read("parts", [id]), S.read("placerOf", [id])]);
      const design = Number(p[0]);
      // the part, and who placed it on a line of its own (an address doesn't wrap mid-way)
      const by = Object.assign(document.createElement("small"), { className: "by", textContent: `by ${same(placer, S.me) ? "you" : short(placer)}` });
      el.querySelector(".first")!.replaceChildren(`${PARTS[design]?.name ?? "Part"} #${id}`, by);
    }).catch(() => {});
    const go = () => ((window as any).__explored = explore(S, round, Number(m.placed), running)); // exposed for tests
    el.querySelector<HTMLButtonElement>(".machine-explore")!.onclick = go;
    const pic = el.querySelector<HTMLElement>(".pic")!;
    pic.classList.add("explorable");
    pic.title = "Explore this machine";
    pic.onclick = go;
  }
  // the machine, read from the chain's board once the card is near the screen
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const pic = el.querySelector<HTMLElement>(".pic")!;
    drawMachine(pic, round, Number(m.placed)).then(dispose => {
      if (pic.isConnected) disposers.add(dispose);
      else dispose();
    }).catch(() => { if (pic.isConnected) pic.innerHTML = `<span class="hint">Couldn't draw it</span>`; });
  }, { rootMargin: "200px" });
  io.observe(el);
  disposers.add(() => io.disconnect());
  return el;
}

async function load() {
  const key = `${S.me.toLowerCase()}/${S.accountVersion}/${S.status!.round}/${S.status!.placed}`;
  if (key === loadedKey) return;
  loadedKey = key;
  const version = ++loadVersion;
  for (const dispose of disposers) dispose();
  disposers.clear();
  root.replaceChildren();
  nextRound = Number(S.status!.round);
  loadingPage = false;
  earlier.hidden = true;
  try { await loadPage(version); }
  catch (error) { if (version === loadVersion) loadedKey = ""; throw error; }
}

async function loadPage(version: number) {
  if (version !== loadVersion || loadingPage || nextRound < 1) return;
  loadingPage = true;
  earlier.disabled = true;
  const from = Math.max(1, nextRound - PAGE + 1), count = nextRound - from + 1;
  try {
    const rows = await S.readViews("archive", [BigInt(from), BigInt(count)]) as Info[];
    if (version !== loadVersion) return;
    root.append(...rows.map((m, i) => card(from + i, m, from + i === Number(S.status!.round))).reverse());
    nextRound = from - 1;
    earlier.hidden = nextRound === 0;
    if (from === 1 && root.children.length === 1 && rows[0]?.placed === 0n) {
      root.insertAdjacentHTML("afterbegin", `<p class="hint">No machine has been built yet.</p>`);
    }
  } finally {
    if (version === loadVersion) { loadingPage = false; earlier.disabled = false; }
  }
}

S.init().then(() => {
  wallet(S, () => load().catch(console.error));
  return load();
}).catch((e) => toast(`Couldn't reach the chain: ${String(e.shortMessage ?? e.message ?? e).split("\n")[0]}`, "bad", 0));
