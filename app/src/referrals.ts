import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { Store, same, short } from "./store";
import { money } from "./usd";
import { toast } from "./ui";

const DEAD = "0x000000000000000000000000000000000000dEaD";

/** One referral level. Attribution is visible, removable, and scoped to this deployment in this browser. */
export class Referrals {
  private saved: Address = zeroAddress;
  private key = "";
  private rate = "3%";

  constructor(private S: Store) {
    document.getElementById("referral-clear")!.onclick = () => {
      if (S.busy) return;
      this.saved = zeroAddress;
      try { localStorage.removeItem(this.key); } catch { /* storage is optional */ }
      const url = new URL(location.href);
      url.searchParams.delete("ref");
      history.replaceState(null, "", url);
      this.render();
    };
    document.getElementById("referral-copy")!.onclick = () => void this.copy();
    document.getElementById("referral-claim")!.onclick = async () => {
      if (!S.me || S.busy || !S.status?.referralEarned) return;
      if (await S.send("claimReferral", [], { label: "Claiming referral rewards", done: "Referral rewards claimed" })) {
        await S.refreshStatus();
        this.render();
        S.onWallet();
      }
    };
  }

  async init() {
    this.key = `machine-referral:${this.S.D.chainId}:${this.S.D.machine.toLowerCase()}`;
    const params = new URLSearchParams(location.search);
    let candidate: string | null = null;
    if (params.has("ref")) candidate = params.get("ref");
    else try { candidate = localStorage.getItem(this.key); } catch { /* storage is optional */ }
    this.saved = candidate && isAddress(candidate) ? getAddress(candidate) : zeroAddress;
    if (same(this.saved, this.S.D.machine) || same(this.saved, DEAD) || same(this.saved, this.S.D.ethMinter)) this.saved = zeroAddress;
    try {
      if (this.saved === zeroAddress) localStorage.removeItem(this.key);
      else localStorage.setItem(this.key, this.saved);
    } catch { /* link still works for this visit */ }
    const bps = Number(await this.S.read("REFERRAL"));
    this.rate = `${bps / 100}%`;
    const docs = new URL("./docs.html", location.href);
    const net = params.get("net");
    if (net) docs.searchParams.set("net", net);
    docs.hash = "referrals";
    (document.querySelector(".referral-share a") as HTMLAnchorElement).href = docs.href;
    this.render();
  }

  address(): Address { return this.saved; }

  render(checkingOut = false) {
    const referrer = this.address();
    const active = referrer !== zeroAddress;
    const row = document.getElementById("mint-referral")!;
    row.hidden = !active;
    const label = document.getElementById("referral-to")!;
    label.textContent = `Referred by ${same(referrer, this.S.me) ? "you" : short(referrer)}`;
    label.title = referrer;
    (document.getElementById("referral-clear") as HTMLButtonElement).disabled = !!this.S.busy || checkingOut;
    const connected = !!this.S.me;
    const input = document.getElementById("referral-link") as HTMLInputElement;
    input.value = connected ? this.link() : "Connect your wallet to get a link";
    (document.getElementById("referral-copy") as HTMLButtonElement).disabled = !connected;
    document.getElementById("referral-description")!.textContent = `Share your link and earn ${this.rate} of what the people you bring spend.`;
    const amount = this.S.status?.referralEarned ?? 0n;
    if (connected) money(document.getElementById("referral-earned")!, amount);
    else document.getElementById("referral-earned")!.textContent = "–";
    (document.getElementById("referral-claim") as HTMLButtonElement).disabled = !connected || amount === 0n || !!this.S.busy;
  }

  private link() {
    const url = new URL("./", location.href);
    const net = new URLSearchParams(location.search).get("net");
    if (net) url.searchParams.set("net", net);
    url.searchParams.set("ref", this.S.me);
    return url.href;
  }

  private async copy() {
    if (!this.S.me) return;
    try {
      await navigator.clipboard.writeText(this.link());
      toast("Referral link copied", "ok");
    } catch {
      const input = document.getElementById("referral-link") as HTMLInputElement;
      input.focus();
      input.select();
      toast("Select and copy your referral link", "", 4000);
    }
  }
}
