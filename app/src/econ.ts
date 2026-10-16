// The v6 economy as the contract computes it (IdentityMachine.sol), so the client can quote exactly.
import { formatUnits } from "viem";

export const MAG = 10n ** 18n;
export const BASE = 100_000_000_000_000_000n; // 0.10 IMD, the first mint of every round
export const PRICE_SCALE = 1500n;
export const CLOCK_ADD = 30; // seconds per placement
export const CLOCK_MAX = 24 * 3600;

/** where every mint goes, in basis points */
export const SPLIT = { plug: 5000, shared: 2600, pot: 1500, reserve: 500, burn: 200, dev: 200 };
export const REFERRAL = 300; // drawn from shared income on referred mints
export const WIN = 7000; // of the pot, to the last ten parts placed
/** first to tenth place's share of the prize, in basis points */
export const PLACES = [3000, 2000, 1300, 1000, 800, 600, 500, 400, 200, 200];

/** IdentityMachine.priceAt: the price of mint number k of a round */
export function priceAt(k: number | bigint, base = BASE): bigint {
  const scaled = PRICE_SCALE + BigInt(k);
  return base * scaled * scaled / (PRICE_SCALE * PRICE_SCALE);
}

export function quote(k: number, n: number, base = BASE): bigint {
  let t = 0n;
  for (let i = 0; i < n; i++) t += priceAt(k + i, base);
  return t;
}

const num = (v: bigint) => Number(formatUnits(v, 18));
/** IMD amounts: enough precision for small parts and large pots alike */
export function fmt(v: bigint, digits?: number): string {
  const n = num(v);
  if (digits !== undefined) return n.toFixed(digits);
  if (n === 0) return "0";
  if (n >= 10_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}
export const compact = (v: bigint) => {
  const n = num(v);
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(0);
};
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** a clock reading: 23:59:30, or 4:05 under an hour */
export function clock(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const two = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
