#!/usr/bin/env node
// Rehearse the swarm's deployment on a local chain: deploy launch.json in order with its constructor
// arguments ($owner and $contract:Name filled in as the swarm does), then print a deployment record in the shape
// the swarm hands the front end (name, address, txHash, blockNumber). Feed it to swarm-manifest.mjs.
//   RPC=http://127.0.0.1:8545 node app/scripts/swarm-deploy.mjs <owner> [delay seconds] > record.json
// Local test key only; this never runs against mainnet (it refuses a chain without anvil's test accounts).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account 0
const rpc = process.env.RPC ?? "http://127.0.0.1:8545";
const [owner, delay] = process.argv.slice(2);
if (!owner || !isAddress(owner)) throw new Error("usage: swarm-deploy.mjs <owner> [delay seconds]");

const root = new URL("../../", import.meta.url);
const launch = JSON.parse(readFileSync(new URL("launch.json", root), "utf8"));
const account = privateKeyToAccount(PK0);
const pub = createPublicClient({ transport: http(rpc) });
const chain = { id: await pub.getChainId(), name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const clientVersion = await pub.request({ method: "web3_clientVersion" });
if (!/anvil/i.test(clientVersion)) throw new Error(`not a local anvil chain: ${clientVersion}`);

const deployed = new Map();
const contracts = [];
for (const { contract, constructorArgs } of launch.contracts) {
  const { abi, bytecode } = JSON.parse(readFileSync(new URL(`out/${contract}.sol/${contract}.json`, root), "utf8"));
  const inputs = abi.find((x) => x.type === "constructor")?.inputs ?? [];
  if (inputs.length !== constructorArgs.length) throw new Error(`${contract}: ${constructorArgs.length} arguments for ${inputs.length} inputs`);
  const args = constructorArgs.map((a, i) => {
    if (a === "$owner") return getAddress(owner);
    if (a.startsWith("$contract:")) {
      const at = deployed.get(a.slice("$contract:".length));
      if (!at) throw new Error(`${contract} refers to ${a} before it is deployed`);
      return at;
    }
    if (contract === "IdentityMachine" && i === constructorArgs.length - 1 && delay !== undefined) return BigInt(delay);
    return inputs[i].type.startsWith("uint") ? BigInt(a) : a;
  });
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${contract} failed to deploy`);
  deployed.set(contract, receipt.contractAddress);
  contracts.push({ name: contract, address: receipt.contractAddress, txHash: hash, blockNumber: Number(receipt.blockNumber) });
}
console.log(JSON.stringify({ version: 1, chainId: 4663, contracts }, null, 2));
