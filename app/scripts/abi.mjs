#!/usr/bin/env node
// Copy the contracts' ABIs from out/ (run `forge build` first) into app/src/abi.
import { readFileSync, writeFileSync } from "node:fs";
const NAMES = ["IdentityMachine", "Parts", "MachineViews", "EthMinter", "DrandBeacon", "DevIMD"];
const root = new URL("../../out/", import.meta.url);
for (const n of NAMES) {
  const { abi } = JSON.parse(readFileSync(new URL(`${n}.sol/${n}.json`, root), "utf8"));
  writeFileSync(new URL(`../src/abi/${n}.json`, import.meta.url), JSON.stringify(abi, null, 2) + "\n");
}
console.log(`abi: ${NAMES.length} contracts`);
