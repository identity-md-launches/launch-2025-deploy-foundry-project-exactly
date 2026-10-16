import { fmt, PLACES, WIN } from "./econ";
import { usd } from "./usd";

// The ten prize places of the running machine, first place first: who holds each one ("You" in amber) and what it
// pays if the round ends now; an open place is a dash. Pressing a row frames that part on the board.
// Small screens fold the list under the clock and jackpot until they are tapped.

export interface TopRow { id: number; name: string; placer: string; mine: boolean }

export class TopTen {
  private root = document.createElement("section");
  private list = document.createElement("ol");
  private key = "";

  constructor(anchor: HTMLElement, private pick: (id: number) => void) {
    this.root.className = "top-ten";
    this.root.setAttribute("aria-label", "Prize places: the last ten parts placed");
    this.list.className = "tt-list";
    this.root.append(this.list);
    anchor.append(this.root);
  }

  update(rows: TopRow[], pot: bigint) {
    const prize = (pot * BigInt(WIN)) / 10_000n;
    const amounts = PLACES.map((b) => (prize * BigInt(b)) / 10_000n);
    const shown = rows.slice(0, 10);
    const pays = (a: bigint) => usd(a) || `${fmt(a)} IMD`;
    const key = JSON.stringify([shown, amounts.map(pays)]);
    if (key === this.key) return;
    this.key = key;
    this.list.replaceChildren(...amounts.map((amount, i) => {
      const r = shown[i];
      const li = document.createElement("li");
      const row = document.createElement(r ? "button" : "span");
      row.className = "tt-row" + (r ? (r.mine ? " mine" : "") : " open");
      // number, player, payout; the part they hold on a second line under the player
      const cells = [String(i + 1).padStart(2, "0"), r ? (r.mine ? "You" : r.placer.toLowerCase()) : "–", pays(amount)];
      row.append(...cells.map((t, k) => {
        const s = document.createElement("span");
        s.className = ["tt-place", "tt-who", "tt-amt"][k];
        s.textContent = t;
        return s;
      }));
      if (r) row.append(Object.assign(document.createElement("span"), { className: "tt-part", textContent: r.name }));
      if (r) {
        (row as HTMLButtonElement).type = "button";
        row.setAttribute("aria-label", `Place ${i + 1}: ${r.mine ? "you" : r.placer}, ${r.name}, pays ${fmt(amount)} IMD if the round ends now`);
        row.onclick = (e) => { e.stopPropagation(); this.pick(r.id); };
      }
      li.append(row);
      return li;
    }));
  }
}
