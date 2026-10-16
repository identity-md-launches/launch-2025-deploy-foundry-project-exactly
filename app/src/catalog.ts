// The Parts page: every part, animated from the same SVG the chain serves, with its odds and earning weight.
import { TIER_CLASS, TIER_WEIGHT, TEMPLATE_NAME, TEMPLATES, bbox, oddsOf } from "./geometry";
import { rarityTag } from "./rarity";
import { PARTS } from "./parts.gen";
import { partImage } from "./render";
import { Store } from "./store";
import { shell, stats, wallet } from "./shell";

const $ = (id: string) => document.getElementById(id)!;
shell("Parts");
const S = new Store();
const B = S.board;
const pct = (x: number) => (x >= 0.01 ? (x * 100).toFixed(1) : (x * 100).toFixed(2)) + "%";

/** the cards, built once; only the placed counts change afterwards */
function build() {
  const root = $("tiers");
  for (const tier of [0, 1, 2, 3, 4]) {
    const h = document.createElement("h2");
    h.innerHTML = `${rarityTag(tier)}<span class="aside">${tier === 4 ? "free for identity.md seats" : `${TIER_WEIGHT[tier]}× share`}</span>`;
    const cards = document.createElement("div");
    cards.className = "cards";
    for (const p of PARTS.filter((x) => x.tier === tier)) {
      const d = B.designs.get(p.id)!;
      const { w, h: hh } = bbox(p.tmpl);
      const card = document.createElement("div");
      card.className = `card tiered ${TIER_CLASS[tier]}`;
      const pic = document.createElement("div");
      pic.className = "pic";
      const img = partImage(p.id, 160);
      img.width = Math.min(230, 120 * Math.max(w, hh));
      img.height = 150;
      const sockets = TEMPLATES[p.tmpl].reduce((n, [, , m]) => n + [1, 2, 4, 8].filter((b) => m & b).length, 0);
      pic.appendChild(img);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${p.name}${rarityTag(tier)}</div><p>${p.about}</p>
        <dl><dt>Odds</dt><dd title="Per mint">${tier === 4 ? "Claimed" : pct(oddsOf(d))}</dd>
        <dt>Shape</dt><dd>${TEMPLATE_NAME[p.tmpl]} ${w}×${hh}</dd>
        <dt>Sockets</dt><dd>${sockets}</dd>
        <dt>This machine</dt><dd id="n${p.id}">–</dd></dl>`;
      card.append(pic, meta);
      cards.appendChild(card);
    }
    root.append(h, cards);
  }
}

function counts() {
  const plugged = new Map<number, number>();
  for (const p of B.parts.values()) if (p.placed) plugged.set(p.design, (plugged.get(p.design) ?? 0) + 1);
  stats([["Parts", B.placedCount.toLocaleString()], ["Kinds found", `${plugged.size} / ${PARTS.length}`]]);
  for (const p of PARTS) $(`n${p.id}`).textContent = (plugged.get(p.id) ?? 0).toLocaleString();
}

build();
S.init().then(() => {
  wallet(S, () => {});
  counts();
  S.on((ev, live) => live && ev.name === "Placed" && counts());
}).catch(console.error);
