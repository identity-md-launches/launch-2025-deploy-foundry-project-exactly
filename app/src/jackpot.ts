import { fmt } from "./econ";

/** a fixed-width clock, 07:05:09, so the big readout never jumps */
const hms = (sec: number) => {
  sec = Math.max(0, Math.floor(sec));
  const two = (x: number) => String(x).padStart(2, "0");
  return `${two(Math.floor(sec / 3600))}:${two(Math.floor((sec % 3600) / 60))}:${two(sec % 60)}`;
};
import { usd } from "./usd";

// The round's headline, at the top of the left column (a strip under the header on small screens):
//   19:47:03      the clock, big, in a pixel font (+30s flashes beside it on an extension)
//   $3.74         the jackpot, bigger still, in the display font
//   (0.428 IMD)   (only when the main figure is in dollars)
// No captions: a clock and an amount explain themselves.
// Before launch the clock counts down to the opening ("Opens in"); after expiry it reads "Time's up". The amount rolls
// up when the pot grows; the last minute turns the clock red and blinks (stepped). Low motion: no rolling, no blinking.

export interface JackpotState { round: number; prize: bigint; deadline: number; start: number; now: number }

export class Jackpot {
  private root = document.createElement("span");
  private clockEl: HTMLElement;
  private clockLabelEl: HTMLElement;
  private bonusEl: HTMLElement;
  private bonusTimer = 0;
  private mainEl: HTMLElement;
  private subEl: HTMLElement;
  private state: JackpotState | null = null;
  private shownMain = "";
  private shownSub = "";
  private starts = false;
  private prizeFrom = 0n;
  private prizeAt = 0;
  private latestDeadline = 0;

  constructor(private anchor: HTMLElement) {
    this.root.className = "jp";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML = `<span class="jp-when"></span><span class="jp-clock"><b class="jp-time">--:--:--</b><em class="jp-bonus"></em></span>` +
      `<b class="jp-main">–</b><span class="jp-sub"></span>`;
    anchor.append(this.root);
    this.clockLabelEl = this.root.querySelector(".jp-when")!;
    this.clockEl = this.root.querySelector(".jp-time")!;
    this.bonusEl = this.root.querySelector(".jp-bonus")!;
    this.mainEl = this.root.querySelector(".jp-main")!;
    this.subEl = this.root.querySelector(".jp-sub")!;
  }

  private clearBonus() {
    clearTimeout(this.bonusTimer);
    this.bonusTimer = 0;
    this.root.classList.remove("bonus");
    this.bonusEl.textContent = "";
    document.getElementById("hud-bonus")!.textContent = "";
  }

  update(next: JackpotState, lowMotion: boolean) {
    const previous = this.state, t = performance.now();
    const sameRound = previous?.round === next.round;
    const starts = next.start > next.now, ended = !starts && next.deadline <= next.now;
    if (previous && sameRound && !starts && !ended && !lowMotion && !this.starts && previous.deadline > previous.now && next.deadline > this.latestDeadline) {
      const bonus = Math.round(next.deadline - this.latestDeadline);
      this.clearBonus();
      document.getElementById("hud-bonus")!.textContent = `+${bonus}s`;
      this.bonusEl.textContent = `+${bonus}s`;
      void this.root.offsetWidth; // restart the flash
      this.root.classList.add("bonus");
      // Clear both the visible label and its announcement; later extensions restart this lifetime.
      this.bonusTimer = window.setTimeout(() => this.clearBonus(), 1600);
    } else if (!sameRound || starts || ended || lowMotion) {
      this.clearBonus();
    }
    if (!previous || next.prize !== previous.prize || !sameRound) {
      const grew = previous && sameRound && next.prize > previous.prize && !lowMotion;
      this.prizeFrom = grew ? this.displayPrize(t) : next.prize;
      this.prizeAt = t;
    }
    const countdown = hms(starts ? next.start - next.now : next.deadline - next.now);
    this.starts = starts;
    this.latestDeadline = sameRound ? Math.max(this.latestDeadline, next.deadline) : next.deadline;
    this.state = next;
    const label = starts ? "Opens in" : ended ? "Round over" : "Time left";
    this.clockLabelEl.textContent = starts ? "Opens in" : ended ? "Time's up" : "";
    this.clockEl.textContent = countdown;
    this.root.classList.toggle("over", ended);
    this.root.classList.toggle("urgent", !lowMotion && !starts && !ended && next.deadline - next.now < 60);
    document.getElementById("hud-round")!.textContent = starts ? "Launch" : `Round ${next.round}`;
    document.getElementById("hud-pot")!.textContent = `${fmt(next.prize)} IMD jackpot`;
    document.getElementById("hud-clock")!.textContent = `${label}: ${countdown}`;
    const dollars = usd(next.prize);
    this.anchor.setAttribute("aria-label", `${dollars ? dollars + ", " : ""}${fmt(next.prize)} IMD jackpot. ${label} ${countdown}.`);
  }

  private displayPrize(t: number) {
    if (!this.state) return 0n;
    const progress = Math.min(1, Math.max(0, (t - this.prizeAt) / 600));
    const eased = BigInt(Math.round((1 - (1 - progress) ** 3) * 1_000_000));
    return this.prizeFrom + (this.state.prize - this.prizeFrom) * eased / 1_000_000n;
  }

  /** Called every frame by the board; touches the DOM only when the shown text changes. */
  paint(lowMotion: boolean) {
    if (!this.state) return;
    const prize = lowMotion ? this.state.prize : this.displayPrize(performance.now());
    const dollars = usd(prize);
    const main = dollars || `${fmt(prize)} IMD`;
    const sub = dollars ? `(${fmt(prize)} IMD)` : "";
    if (main !== this.shownMain) { this.shownMain = main; this.mainEl.textContent = main; }
    if (sub !== this.shownSub) { this.shownSub = sub; this.subEl.textContent = sub; }
  }
}
