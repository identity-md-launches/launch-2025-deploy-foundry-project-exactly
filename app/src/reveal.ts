// Which part a mint reveals, worked out from its drand signature exactly as IdentityMachine.reveal does, so a
// player sees (and can arrange) their parts as soon as the beacon publishes, before anything is sent on chain.
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { PARTS, TEMPLATES } from "./parts.gen";
import { DROPS } from "./geometry";

/** IdentityMachine.rollTier */
export function rollTier(x: bigint) {
  const r = Number(x % 10_000n);
  return r < 7000 ? 0 : r < 9200 ? 1 : r < 9900 ? 2 : 3;
}

/** Shapes.rollDrop: the template for `tier` */
export function rollDrop(tier: number, x: bigint) {
  let r = x % 1000n;
  for (let t = 0; t < TEMPLATES.length; t++) {
    const w = BigInt(DROPS[tier]?.[t] ?? 0);
    if (r < w) return t;
    r -= w;
  }
  throw new Error("no template");
}

/** Catalog.slotParts: the slot's part ids in ascending order */
const slot = (tier: number, tmpl: number) => PARTS.filter((p) => p.tier === tier && p.tmpl === tmpl).map((p) => p.id);

/** the design mint `id` reveals, given its drand round's signature (DrandBeacon: randomness = keccak256(sig)) */
export function predict(sig: Hex, id: number): number {
  const r = keccak256(sig);
  const x = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [r, BigInt(id)])));
  const tier = rollTier(x);
  const tmpl = rollDrop(tier, x >> 16n);
  const ids = slot(tier, tmpl);
  return ids[Number((x >> 32n) % BigInt(ids.length))];
}
