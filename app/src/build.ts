import { type Hex } from "viem";
import { MAX_DRAFT_PARTS, type Draft } from "./geometry";
import { machineAbi } from "./chain";
import { type Store, isGasLimitError } from "./store";

/** Installation ceiling; independent of the 200-item mint limit. */
export const MAX_INSTALL = MAX_DRAFT_PARTS;

/** Validate the entire draft for one transaction; never silently install a smaller prefix. */
export async function buildBatch(S: Store, round: number, drafts: Draft[], sigs: Map<number, Hex>, maxParts = MAX_INSTALL) {
  const count = drafts.length;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("No parts ready to install");
  if (count > Math.min(maxParts, MAX_INSTALL)) throw new Error("Arrange up to 50 parts before installing");
  if (drafts.some(d => !d.ok)) throw new Error("Move or remove the parts that don't fit");
  const exit = S.board.growthExit(drafts.flatMap(d => d.fp));
  if (!exit) throw new Error("Leave an outside connection open");
  const block = await S.pub.getBlock();
  // Leave room for estimation variance and stay below the client's 15M transaction budget.
  const limit = block.gasLimit < 15_000_000n ? block.gasLimit : 15_000_000n;
  const budget = limit * 9n / 10n;
  const ids = drafts.filter(d => d.id < 0 && S.pending.has(-d.id)).map(d => BigInt(-d.id));
  const rounds = [...new Set(ids.map(id => S.pending.get(Number(id))!.drand))];
  const proofs = rounds.map(r => {
    const sig = sigs.get(r);
    if (!sig) throw new Error("Beacon not ready. Try again in a few seconds");
    return { drandRound: BigInt(r), sig };
  });
  const args = [BigInt(round), proofs, ids, drafts.map(d => ({ id: BigInt(Math.abs(d.id)), rot: d.rot, x: d.x, y: d.y })), exit];
  const tooLarge = "This draft is too large to install. Remove a few parts and try again";
  try {
    const gas = await S.pub.estimateContractGas({ address: S.D.machine, abi: machineAbi, functionName: "build", args, account: S.me, gas: budget } as any);
    if (gas > budget) throw new Error(tooLarge);
    return { drafts: [...drafts], args, gas: (gas * 11n + 9n) / 10n };
  } catch (e) {
    if (isGasLimitError(e)) throw new Error(tooLarge);
    throw e;
  }
}
