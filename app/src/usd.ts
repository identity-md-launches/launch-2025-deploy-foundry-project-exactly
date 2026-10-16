// Dollar values next to IMD and ETH amounts, from on-chain prices only (no price API):
//   ETH/USD   Chainlink's ETH / USD feed on Robinhood Chain (data.chain.link, network robinhood-mainnet)
//   IMD/ETH   the Uniswap v4 IMD/ETH pool that PepesFamily trades through (its ETH router's imdEthKey():
//             ETH / IMD, 1% fee, tick spacing 100, no hook), read from the PoolManager's storage
// Always read from Robinhood Chain mainnet, also on the local test chain, so testing shows realistic dollars.
// Refreshed every minute; if a read fails the dollar figures are simply left out.
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, type Hex } from "viem";
import { robinhood } from "./chain";
import { fmt } from "./econ";

const ETH_USD = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const IMD = "0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127";
const ZERO = "0x0000000000000000000000000000000000000000";
const POOLS_SLOT = 6n; // Uniswap v4 PoolManager: mapping(PoolId => Pool.State) at slot 6; slot0 is the state's first word

const poolId = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
  [ZERO, IMD, 10_000, 100, ZERO],
));
const slot0 = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT]));

const abi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function extsload(bytes32) view returns (bytes32)",
]);
const client = createPublicClient({ chain: robinhood, transport: http() });

let ethUsd: number | null = null; // dollars per ETH
let imdUsd: number | null = null; // dollars per IMD

async function refresh() {
  try {
    const [round, word] = await Promise.all([
      client.readContract({ address: ETH_USD, abi, functionName: "latestRoundData" }),
      client.readContract({ address: POOL_MANAGER, abi, functionName: "extsload", args: [slot0] }),
    ]);
    const eth = Number(round[1]) / 1e8;
    const sqrtP = BigInt(word as Hex) & ((1n << 160n) - 1n);
    const imdPerEth = (Number(sqrtP) / 2 ** 96) ** 2; // currency1 (IMD) per currency0 (ETH), both 18 decimals
    if (eth > 0 && imdPerEth > 0) {
      ethUsd = eth;
      imdUsd = eth / imdPerEth;
    }
  } catch {
    // keep the last good prices; with none, dollar figures stay hidden
  }
}
refresh();
setInterval(refresh, 60_000);

/** "$1,234", "$4.70", "<$0.01"; "" while no price is known */
export function dollars(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  return v > 0 ? "<$0.01" : "$0";
}

/** dollars for an IMD amount in wei ("" while the price is unknown) */
export const usd = (imdWei: bigint) => (imdUsd === null ? "" : dollars((Number(imdWei) / 1e18) * imdUsd));
/** dollars for an ETH amount in wei */
export const usdEth = (ethWei: bigint) => (ethUsd === null ? "" : dollars((Number(ethWei) / 1e18) * ethUsd));
/** " ($4.70)" for plain-text places (log lines, toasts), or "" */
export const paren = (imdWei: bigint) => (usd(imdWei) ? ` (${usd(imdWei)})` : "");

/** write "1.24 IMD" into `el` with a smaller muted "($10.85)" after it; `text` overrides the amount text */
export function money(el: HTMLElement, imdWei: bigint, text = `${fmt(imdWei)} IMD`, dollar = usd(imdWei)) {
  const small = document.createElement("small");
  small.className = "usd";
  small.textContent = dollar ? `(${dollar})` : "";
  el.replaceChildren(document.createTextNode(text), ...(dollar ? [document.createTextNode(" "), small] : []));
}
