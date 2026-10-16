import { formatEther } from "viem";
import { ethMinterAbi } from "./chain";
import type { Store } from "./store";

export const fmtEth = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
const margin = (v: bigint) => (v * 102n + 99n) / 100n;

/** Quotes belong to a quantity, price, round and wallet. A slow response can never replace a newer selection. */
export class EthCheckout {
  /** eth: the quoted cost; maxEth / maxImd: the 2% margin sent as the limit (unused ETH is refunded) */
  quote: { key: string; eth: bigint; maxImd: bigint; maxEth: bigint; balance: bigint; expires: bigint } | null = null;
  loading = false;
  error = "";
  private key = "";
  private updated = 0;
  private request = 0;
  constructor(private S: Store, private changed: () => void) {}

  refresh(n: number, total: bigint, now: number) {
    const { S } = this;
    const key = `${n}:${total}:${S.status?.round}:${S.me.toLowerCase()}`;
    if (key === this.key && (this.loading || Date.now() - this.updated < (this.error ? 5000 : 15000))) return;
    if (key !== this.key) this.quote = null;
    this.key = key;
    const request = ++this.request;
    this.loading = true;
    this.error = "";
    Promise.all([
      S.pub.simulateContract({ address: S.D.ethMinter!, abi: ethMinterAbi, functionName: "quote", args: [BigInt(n)] } as any),
      S.me ? S.pub.getBalance({ address: S.me }) : Promise.resolve(0n),
    ]).then(([r, balance]) => {
      if (request !== this.request) return;
      // the contract quotes the price at this moment; if someone minted since the page's last read it is a little
      // higher than `total`, which is fine: the margin covers small moves and the mint itself checks maxImd
      const [imd, eth] = r.result as unknown as [bigint, bigint];
      if (imd <= 0n || eth <= 0n) throw new Error("empty quote");
      this.quote = { key, eth, maxImd: margin(imd), maxEth: margin(eth), balance, expires: BigInt(Math.floor(now + 120)) };
    }).catch(() => {
      if (request !== this.request) return;
      this.quote = null;
      this.error = "Couldn’t get an ETH quote. Retrying…";
    }).finally(() => {
      if (request !== this.request) return;
      this.loading = false;
      this.updated = Date.now();
      this.changed();
    });
  }
}
