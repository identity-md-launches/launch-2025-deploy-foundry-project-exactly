# Committed launch tests

These tests extend the existing deployment, gameplay, and security suites. They deploy
the actual `DrandBeacon`, `IdentityMachine`, `MachineViews`, and `EthMinter` artifacts
in one factory call, in manifest order. Constructor arguments are read from
`launch.json`; `$owner` uses the payout address in the accepted
`LaunchDeployment.t.sol` fixture. Chain ID is 4663. No application implementation,
storage, constructor value, or compiler setting is replaced.

`ManifestFixture.sol` installs offline dependency models at the manifest's external
IMD, PoolManager, and Quoter addresses **after** deployment. `SettlementModel.sol`
checks the pool key, exact-output swap direction and signed deltas, and settlement
of both currencies before returning from `unlock`. It transfers a finite supply of
funded tokens rather than minting swap proceeds. Its configurable fixed exchange
rate is not a model of Uniswap liquidity or price impact. The token's blocklist
switch exercises the already documented external-token availability risk.

`CheckoutInvariant.t.sol` runs 256 sequences of 64 calls across three actors. Its
handler mixes purchases, exchange-rate changes, funding, sponsorship, time changes,
round endings, donations, withdrawals, and intentionally rejected transactions.
Only the listed handler selectors are fuzzed; fixture setters and token minting
are not targets. Unexpected handler reverts fail the campaign.

The invariant properties are:

- Every IMD entering the machine is held, burned, or paid to a recorded beneficiary.
  Its balance equals all current pot, reserve, developer, referral, pending plug-pay,
  and placed-item liabilities. A core claimed with the real snapshot proof has
  weight one, allowing exact accounting without a rounding tolerance.
- Checkout holds only explicitly tracked donations, leaves no spending allowance,
  and charges each actor exactly the ETH delivered to the pool. Pool obligations
  are cleared after every completed transaction.
- Successful paid mints alone create pending items. Unproven pending items never
  enter inventory, and their plug-pay remains backed across round changes.
- Rejected payments preserve balances and state, including a token burn failure
  after tentative mint and round-end writes. Failed developer payments preserve
  the unpaid credit. End-of-sequence withdrawals test that accrued claims remain
  payable and cannot be withdrawn twice.

A deterministic sequence exercises all five purchase faults and a blocked payout,
then retries successfully across a round boundary. Random paid items deliberately
remain pending because arbitrary future drand signatures cannot be fabricated.
The existing gameplay invariant suite covers random reveal and placement sequences.

`LaunchBehavior.t.sol` covers the 48-hour opening boundary, refund rejection and
recovery, and 1,000 fuzzed stale-quote cases including the full 200-item batch range.
Its proof/reveal/build test uses the existing committed evmnet signature for round
21,238,365. Both ownership and growth failures must undo the beacon proof itself,
as well as every reveal and placement effect, before the same valid build succeeds.

Run from the repository root:

```sh
FOUNDRY_FUZZ_SEED=0x58343bfb2f5a303aa2e7b4ccc15fcc1a25fa19801efc18ca0f6915718497dac6 forge test --match-path 'test/launch/*.t.sol'
forge build
FOUNDRY_FUZZ_SEED=0x58343bfb2f5a303aa2e7b4ccc15fcc1a25fa19801efc18ca0f6915718497dac6 forge test
```

These tests require neither network access nor additional dependencies. Live
Robinhood pool liquidity, current dependency code and blocklist state, and live
drand relay behavior still require the existing fork tests. Offline fixtures do
not verify those live-chain conditions.
