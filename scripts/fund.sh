#!/usr/bin/env bash
# Give an address test ETH and test IMD on the local chain, to play with your own browser wallet.
#   scripts/fund.sh 0xYourAddress
# Then open the site with ?wallet=injected and add the network to your wallet if asked:
#   RPC http://127.0.0.1:8545, chain id 31337.
set -euo pipefail
cd "$(dirname "$0")/.."
TO=${1:?usage: scripts/fund.sh 0xAddress}
RPC=http://127.0.0.1:8545
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
IMD=$(python3 -c "import json;print(json.load(open('app/public/deploy.local.json'))['imd'])")
cast send "$TO" --value 10ether --private-key $PK0 --rpc-url $RPC >/dev/null
cast send "$IMD" "mint(address,uint256)" "$TO" 100000ether --private-key $PK0 --rpc-url $RPC >/dev/null
echo "funded $TO with 10 test ETH and 100,000 test IMD on the local chain"
