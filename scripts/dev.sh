#!/usr/bin/env bash
# Local dev chain for THE MACHINE: anvil + real drand beacon + dev IMD + 24-hour rounds.
#   scripts/dev.sh          start anvil (port 8545), deploy, fund the 10 anvil accounts
# Then: cd app && npm run dev   (and optionally: npm run bots)
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8545
if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  anvil --block-time 1 --silent > /tmp/machine-anvil.log 2>&1 &
  echo "anvil pid $!"
  for i in $(seq 30); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
fi
(forge script script/DevDeploy.s.sol --rpc-url $RPC --broadcast --slow >/tmp/machine-deploy.log 2>&1) || { cat /tmp/machine-deploy.log; exit 1; }
IMD=$(python3 -c "import json;print(json.load(open('app/public/deploy.local.json'))['imd'])")
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
for i in $(seq 0 9); do
  A=$(cast rpc anvil_nodeInfo --rpc-url $RPC >/dev/null 2>&1; cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index $i)
  cast send $IMD "mint(address,uint256)" $A 100000ether --private-key $PK0 --rpc-url $RPC >/dev/null
done
cat app/public/deploy.local.json; echo
