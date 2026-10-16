#!/usr/bin/env bash
# Rehearsal on a local copy of Robinhood Chain: the real IMD, IMD/ETH pool and drand.
#   scripts/fork.sh [address ...]   fork as chain 31337 on port 8545 (PORT=...), deploy with Deploy.s.sol (minting
#                                   open now), fund each address with 10 ETH and 200 IMD. Then open the site with
#                                   ?net=fork&wallet=injected.
#   FUND_ONLY=1 scripts/fork.sh <address ...>   fund more addresses on the running fork, no redeploy (only within a
#                                   few minutes of the start: the public RPC forgets older state; pass every wallet up front)
#   SWARM=1 scripts/fork.sh [address ...]       deploy launch.json the way the swarm does instead (dev payout:
#                                   SWARM_OWNER, default test wallet 1) and build the manifest from its deployment record;
#                                   SWARM_DELAY=<seconds> adds a real countdown (minting opens after it, in real time)
# Nothing touches mainnet: the fork runs locally as chain 31337, so wallets use the local RPC, never mainnet.
# Rounds last 24 hours as on mainnet. To see one end: cast rpc evm_increaseTime 86400 --rpc-url ...; after that,
# new mints wait a day for their drand round (a fork can't move time back).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8545}
RPC=http://127.0.0.1:$PORT
MAINNET=https://rpc.mainnet.chain.robinhood.com
IMD=0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127
IMD_BALANCE_SLOT=5
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  [ "$(cast call $IMD 'decimals()(uint8)' --rpc-url $RPC 2>/dev/null)" = "18" ] \
    || { echo "port $PORT runs a chain that is not a Robinhood fork: stop it first"; exit 1; }
else
  anvil --fork-url $MAINNET --port $PORT --block-time 1 --disable-block-gas-limit --silent \
    > /tmp/machine-fork.log 2>&1 &
  echo "fork pid $!"
  for i in $(seq 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 1; done
fi

if [ -z "${FUND_ONLY:-}" ]; then
# deploy as on mainnet (the script insists on chain 4663), minting open now; then the fork becomes chain 31337 so
# wallets treat it as a local chain. The manifest goes straight to deploy.fork.json, so a real deploy.robinhood.json
# is never touched, and forge's chain-4663 broadcast record is put back afterwards, even if the deploy fails.
BROADCAST=broadcast/Deploy.s.sol/4663
SAVED=$(mktemp -d)
[ -d $BROADCAST ] && cp -a $BROADCAST $SAVED/4663
restore() {
  cast rpc anvil_setChainId 31337 --rpc-url $RPC >/dev/null 2>&1 || true
  rm -rf $BROADCAST
  [ -d $SAVED/4663 ] && mkdir -p "$(dirname $BROADCAST)" && cp -a $SAVED/4663 $BROADCAST
  rm -rf $SAVED
}
trap restore EXIT
cast rpc anvil_setChainId 4663 --rpc-url $RPC >/dev/null
if [ -n "${SWARM:-}" ]; then
  # as the swarm deploys: launch.json in order, then the site's manifest from the deployment record
  (forge build >/dev/null)
  OWNER=${SWARM_OWNER:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}
  RPC=$RPC node app/scripts/swarm-deploy.mjs $OWNER ${SWARM_DELAY:-0} > /tmp/machine-fork-record.json
  DELAY=${SWARM_DELAY:-0} RPC=$RPC node app/scripts/swarm-manifest.mjs /tmp/machine-fork-record.json app/public/deploy.fork.json --check --dev $OWNER
else
(DELAY=0 MANIFEST_PATH=app/public/deploy.fork.json FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol \
  --rpc-url $RPC --broadcast --private-key $PK0 --slow > /tmp/machine-fork-deploy.log 2>&1) \
  || { tail -30 /tmp/machine-fork-deploy.log; exit 1; }
fi
cast rpc anvil_setChainId 31337 --rpc-url $RPC >/dev/null
python3 - <<'PY'
import json
d = json.load(open("app/public/deploy.fork.json")); d["chainId"] = 31337
json.dump(d, open("app/public/deploy.fork.json", "w"), indent=2)
PY
fi
for A in "$@"; do
  cast rpc anvil_setBalance $A 0x8AC7230489E80000 --rpc-url $RPC >/dev/null # 10 ETH
  cast rpc anvil_setStorageAt $IMD $(cast index address $A $IMD_BALANCE_SLOT) \
    $(cast to-uint256 $(cast to-wei 200)) --rpc-url $RPC >/dev/null
  echo "$A: $(cast balance $A --ether --rpc-url $RPC) ETH, $(cast call $IMD 'balanceOf(address)(uint256)' $A --rpc-url $RPC | awk '{print $1/1e18}') IMD"
done
# The fork copies mainnet state lazily, as of its starting block, and the public RPC keeps only minutes of history:
# a slot first read later fails ("historical state ... is not available"). Read now everything the game touches:
# IMD balances, freeze-list and allowances for every wallet and contract, and the ETH/IMD pool for a single, a pack
# and a box. Pass every wallet you will use when the fork starts; FUND_ONLY later works only within minutes.
D=app/public/deploy.fork.json
M=$(python3 -c "import json;print(json.load(open('$D'))['machine'])")
E=$(python3 -c "import json;print(json.load(open('$D'))['ethMinter'])")
V=$(python3 -c "import json;print(json.load(open('$D'))['views'])")
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
DEAD=0x000000000000000000000000000000000000dEaD
for A in "$@" $M $E $DEAD; do # as recipient, from the pool manager, which holds IMD
  cast call $IMD 'transfer(address,uint256)(bool)' $A 1 --from $PM --rpc-url $RPC >/dev/null
done
for A in "$@"; do # as sender and spender, and the site's first read
  cast call $IMD 'transfer(address,uint256)(bool)' $M 1 --from $A --rpc-url $RPC >/dev/null
  for S in $M $E; do cast call $IMD 'allowance(address,address)(uint256)' $A $S --rpc-url $RPC >/dev/null; done
  cast call $V 'status(address,uint256[])' $A '[]' --rpc-url $RPC >/dev/null
done
cast call $IMD 'allowance(address,address)(uint256)' $E $M --rpc-url $RPC >/dev/null
for N in 1 5 20; do cast call $E 'quote(uint256)(uint256,uint256)' $N --rpc-url $RPC >/dev/null; done
echo "state copied for $# wallet(s), the contracts and the pool"
cat $D; echo
echo "site: http://127.0.0.1:5173/?net=fork&wallet=injected"
