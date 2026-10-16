// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Base, G} from "./Base.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";

/// Edge cases and boundaries not covered elsewhere: the rarity and drop rolls at their limits, the prize table,
/// weights, mint positions across rounds, exact-deadline behaviour, ordering and clock effects
/// inside one build, and agreement between the `check` view and a real build.
contract EdgeCasesTest is Base {
    // ------------------------------------------------------------------ rolls and tables

    function test_rollTierBoundaries() public view {
        assertEq(m.rollTier(0), 0);
        assertEq(m.rollTier(6999), 0);
        assertEq(m.rollTier(7000), 1);
        assertEq(m.rollTier(9199), 1);
        assertEq(m.rollTier(9200), 2);
        assertEq(m.rollTier(9899), 2);
        assertEq(m.rollTier(9900), 3);
        assertEq(m.rollTier(9999), 3);
        // only x mod 10,000 matters
        assertEq(m.rollTier(10_000), 0);
        assertEq(m.rollTier(19_900), 3);
        assertEq(m.rollTier(type(uint256).max), m.rollTier(type(uint256).max % 10_000));
    }

    /// a mint can never drop an Agent Core (seat-only) and always drops a part of the tier it rolled
    function testFuzz_mintedPartsMatchTheirRollAndAreNeverAgentCores(uint256 x) public view {
        uint8 tier = m.rollTier(x);
        uint8 t = Shapes.rollDrop(tier, x >> 16);
        uint16 d = Catalog.partFor(tier, t, x >> 32);
        assertTrue(d != Catalog.AGENT_CORE, "minted an Agent Core");
        assertEq(Catalog.tierOf(d), tier);
        assertEq(Catalog.tmplOf(d), t);
    }

    /// the drop roll always resolves (no BadTemplate) and never picks a template with zero odds
    function testFuzz_rollDropResolves(uint8 tierSeed, uint256 x) public pure {
        uint8 tier = tierSeed % 4;
        uint8 t = Shapes.rollDrop(tier, x);
        assertGt(Shapes.dropOdds(tier, t), 0, "dropped a template with zero odds");
    }

    /// the ten prize shares add up to the whole prize, never increase, and there is no eleventh share
    function test_placeSharesCoverTheWholePrizeAndStopAtTen() public view {
        uint256 sum;
        uint256 last = type(uint256).max;
        for (uint256 i; i < 10; ++i) {
            uint256 b = m.placeBps(i);
            assertGt(b, 0);
            assertLe(b, last, "a lower place pays more");
            last = b;
            sum += b;
        }
        assertEq(sum, m.BPS());
        assertEq(m.placeBps(0), 3000);
        for (uint256 i = 10; i < 16; ++i) assertEq(m.placeBps(i), 0);
    }

    function test_everyDesignWeighsByItsTier() public {
        for (uint16 d; d < Catalog.COUNT; ++d) {
            uint8 tier = Catalog.tierOf(d);
            uint256 want = tier == 3 ? 20 : tier == 2 ? 5 : tier == 1 ? 2 : 1; // Agent Core (tier 4) shares like a common
            assertEq(m.weightOf(d), want);
        }
        assertEq(m.weightOf(Catalog.AGENT_CORE), 1);
        vm.expectRevert(Catalog.NoSuchPart.selector);
        m.weightOf(Catalog.COUNT);
    }

    // ------------------------------------------------------------------ exact deadlines

    function test_mintAtTheExactDeadlineOpensTheNextRoundAtTheBasePrice() public {
        uint256 deadline = _round().deadline;
        vm.warp(deadline - 1);
        (, uint256 paid) = _mint(alice, 1);
        assertEq(m.round(), 1);
        assertEq(paid, m.priceAt(0));
        (, paid) = _mint(alice, 1); // still round 1: the second mint's price
        assertEq(paid, m.priceAt(1));

        vm.warp(deadline);
        (, uint256 total) = _mint(alice, 1);
        assertEq(m.round(), 2, "a mint at the deadline must end the round first");
        assertEq(total, BASE, "the new round starts over at the base price");
    }

    function test_sponsorWorksOneSecondBeforeTheDeadlineAndNotAtIt() public {
        uint256 id = _grant(alice, G.CAP);
        _place(alice, id, 2, 0, 2);
        uint256 deadline = _round().deadline;
        vm.warp(deadline - 1);
        m.sponsor(1 ether);
        assertApproxEqAbs(m.earned(id), 1 ether, 1);
        vm.warp(deadline);
        vm.expectRevert(IdentityMachine.RoundOver.selector);
        m.sponsor(1 ether);
    }

    function test_endRoundOnlyOnceAndNeverEarly() public {
        vm.expectRevert(IdentityMachine.RoundRunning.selector);
        m.endRound();
        vm.warp(_round().deadline - 1);
        vm.expectRevert(IdentityMachine.RoundRunning.selector);
        m.endRound();
        vm.warp(_round().deadline);
        m.endRound();
        assertEq(m.round(), 2);
        vm.expectRevert(IdentityMachine.RoundRunning.selector); // the next machine is running now
        m.endRound();
    }

    // ------------------------------------------------------------------ inside one build

    function _lineSpots(address who, uint256 n) internal returns (IdentityMachine.Spot[] memory s) {
        s = new IdentityMachine.Spot[](n);
        for (uint256 i; i < n; ++i) s[i] = IdentityMachine.Spot(_grant(who, G.PATCH), 0, int32(int256(i + 2)), 0);
    }

    /// the last spot of a batch is the last part placed: prize places follow the order of spots within one build
    function test_prizePlacesFollowSpotOrderWithinOneBuild() public {
        IdentityMachine.Spot[] memory s = _lineSpots(alice, 12);
        uint256 r = _r();
        vm.prank(alice);
        m.build(r, noProofs, noIds, s);
        vm.warp(_round().deadline);
        m.endRound();
        for (uint256 i; i < 12; ++i) {
            uint256 place = i < 2 ? 0 : 12 - i; // spot 11 → first place, spot 2 → tenth, spots 0 and 1 → none
            assertEq(_placeOf(s[i].id), place);
        }
        assertEq(m.order(r, 12), s[11].id);
    }

    /// each placement in a batch adds thirty seconds; the cap applies after every one of them
    function test_oneBuildExtendsTheClockPerPartUpToTheCap() public {
        uint256 r = _r();
        // 100 s after the round opened there are 100 s of headroom under the 24 h cap: the first placements
        // fill it, the rest of the batch adds nothing
        vm.warp(_round().begin + 100);
        assertEq(_round().deadline + 100, _now() + m.CLOCK_MAX());
        IdentityMachine.Spot[] memory s = _lineSpots(alice, 12);
        vm.prank(alice);
        m.build(r, noProofs, noIds, s);
        assertEq(_round().deadline, _now() + m.CLOCK_MAX(), "capped at 24 h from now");

        // two hours later there is room: every part of a batch adds its 30 s
        vm.warp(_now() + 2 hours);
        uint256 before = _round().deadline;
        IdentityMachine.Spot[] memory more = new IdentityMachine.Spot[](12);
        for (uint256 i; i < 12; ++i) more[i] = IdentityMachine.Spot(_grant(alice, G.PATCH), 0, int32(int256(i + 14)), 0);
        vm.prank(alice);
        m.build(r, noProofs, noIds, more);
        assertEq(_round().deadline, before + 12 * m.CLOCK_ADD(), "uncapped: 30 s per part");
    }

    /// a mint that was never revealed is not an item yet: it cannot be placed without revealing it in the same build
    function test_placingAnUnrevealedMintRevertsAndLeavesItPending() public {
        (uint256 id,) = _mint(alice, 1);
        _rig(id, type(uint16).max);
        uint256 r = _r();
        vm.prank(alice);
        vm.expectRevert(Parts.UnknownPart.selector);
        m.build(r, noProofs, noIds, _spots1(id, 0, 2, 0));
        (address owner,) = m.pending(id);
        assertEq(owner, alice, "still pending");
        assertEq(_round().placed, 0);
    }

    function test_revealIgnoresUnknownZeroAndAlreadyRevealedIds() public {
        uint256 id = _get(alice, G.PATCH);
        uint256 next = m.nextId();
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (0, 999_999, id);
        m.reveal(ids);
        assertEq(m.nextId(), next);
        assertEq(_design(id), G.PATCH);
        assertEq(parts.ownerOf(id), alice);
    }

    // ------------------------------------------------------------------ the check view agrees with building

    /// place a new `design` for `who` at (x, y) in the first rotation that fits
    function _placeFitting(address who, uint16 design, int32 x, int32 y) internal {
        for (uint8 rot; rot < 4; ++rot) {
            try m.check(design, rot, x, y) {
                _place(who, _grant(who, design), rot, x, y);
                return;
            } catch {}
        }
        revert("no rotation fits");
    }

    /// a small machine with sockets, blanks and corners around the core to test against
    function _fixture() internal {
        _placeFitting(bob, G.CROSS, 0, -2); // N of the core: four sockets
        _placeFitting(bob, G.BEND, 2, 0); // E of the core: a corner, one blank face outward
        _placeFitting(bob, G.PATCH, 0, 2); // S of the core: a straight, blank sides
        _placeFitting(bob, G.TEE, -2, 0); // W of the core
    }

    /// `check` (for agents and the UI) must give the same verdict as a real build: the same error, or success with
    /// exactly the payees the build pays. A build may additionally fail only for the final outward-socket rule.
    /// (Only a few percent of random spots fit, hence the extra runs.)
    /// forge-config: default.fuzz.runs = 2048
    function testFuzz_checkAgreesWithBuild(uint16 designSeed, uint8 rotSeed, int32 x, int32 y) public {
        _fixture();
        uint16 d = designSeed % Catalog.COUNT;
        uint8 rot = rotSeed % 5; // 4 is invalid on purpose
        x = int32(bound(x, -4, 4));
        y = int32(bound(y, -4, 4));

        (bool fits, bytes memory why) = address(m).staticcall(abi.encodeCall(m.check, (d, rot, x, y)));
        uint256 id = _grantPlug(alice, d, 1 ether);
        uint256 r = _r();
        vm.recordLogs();
        vm.prank(alice);
        (bool built, bytes memory err) = address(m).call(abi.encodeWithSignature(
            "build(uint256,(uint64,bytes)[],uint256[],(uint256,uint8,int32,int32)[])", r, noProofs, noIds, _spots1(id, rot, x, y)));

        if (!fits) {
            assertFalse(built, "check rejected a placement that builds");
            assertEq(bytes4(err), bytes4(why), "check and build disagree on the reason");
            return;
        }
        if (!built) {
            assertEq(bytes4(err), IdentityMachine.NoGrowthExit.selector, "check accepted a placement build rejects");
            return;
        }
        uint256[] memory payees = abi.decode(why, (uint256[]));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 plugged = keccak256("Plugged(uint256,uint256,uint256)");
        uint256[] memory paid = new uint256[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == plugged) paid[n++] = uint256(logs[i].topics[2]);
        }
        assertEq(n, payees.length, "check lists a different number of payees");
        // same multiset: every payee is paid as often as check lists it
        for (uint256 i; i < payees.length; ++i) {
            uint256 want;
            uint256 got;
            for (uint256 j; j < payees.length; ++j) if (payees[j] == payees[i]) ++want;
            for (uint256 j; j < n; ++j) if (paid[j] == payees[i]) ++got;
            assertEq(got, want);
        }
    }

    // ------------------------------------------------------------------ the clock over many builds

    /// the deadline never moves back and never runs more than 24 hours ahead, whatever the timing of builds
    function testFuzz_deadlineIsMonotonicAndCapped(uint256 seed) public {
        uint256 prev = _round().deadline;
        for (uint256 i; i < 15; ++i) {
            uint256 dt = uint256(keccak256(abi.encode(seed, i))) % 3 hours;
            if (_now() + dt >= _round().deadline) break;
            vm.warp(_now() + dt);
            uint256 id = _grant(alice, G.PATCH);
            _place(alice, id, 0, int32(int256(i + 2)), 0);
            uint256 deadline = _round().deadline;
            assertGe(deadline, prev, "the deadline moved back");
            assertLe(deadline, _now() + m.CLOCK_MAX(), "more than 24 hours on the clock");
            prev = deadline;
        }
    }
    // ------------------------------------------------------------------ one batch = the same spots one by one

    struct Snapshot {
        uint256 pot;
        uint256 deadline;
        uint256 open;
        uint256 placed;
        int32 minX;
        int32 minY;
        int32 maxX;
        int32 maxY;
        uint256 totalPaid;
        uint256 balance;
        bytes parts; // per part: credit, earned, placer, place, machine, rot, x, y, plug
        bytes order;
    }

    function _snap(uint256[] memory ids) internal view returns (Snapshot memory s) {
        uint256 r = _r();
        (s.pot, s.deadline, s.open, s.placed) = (_round().pot, _round().deadline, _round().open, _round().placed);
        (s.minX, s.minY, s.maxX, s.maxY) = (_round().minX, _round().minY, _round().maxX, _round().maxY);
        (s.totalPaid, s.balance) = (m.totalPaid(), imd.balanceOf(address(m)));
        for (uint256 i; i < ids.length; ++i) {
            (, uint8 rot, uint8 place, uint32 machine, int32 x, int32 y,, uint112 plug) = m.parts(ids[i]);
            s.parts = bytes.concat(s.parts, abi.encode(m.credit(ids[i]), m.earned(ids[i]), m.placerOf(ids[i]), place, machine, rot, x, y, plug));
        }
        for (uint256 k = 1; k <= s.placed; ++k) s.order = bytes.concat(s.order, abi.encode(m.order(r, k)));
    }

    /// Installing parts as one batch must have exactly the effect of installing the same spots one at a time, in
    /// order: the same plug-pay to the same parts and the pot, clock, open sockets, bounds, build order and balances.
    /// (Batches are what players send; most other tests place one part per build.)
    function testFuzz_batchBuildEqualsTheSameSpotsOneByOne(uint256 seed) public {
        uint256[] memory all = new uint256[](16);
        _resetFrontier();
        // someone else's parts on the machine already, so plug-pay flows to parts as well as the core
        for (uint256 i; i < 4; ++i) {
            all[i] = _grantPlug(bob, _drop(uint256(keccak256(abi.encode("bobpart", seed, i)))), 0.01 ether);
            this.growExt(bob, all[i], uint256(keccak256(abi.encode("bob", seed, i))), 40);
        }
        for (uint256 i; i < 12; ++i) all[4 + i] = _grantPlug(alice, _drop(uint256(keccak256(abi.encode(seed, i)))), 0.01 ether + i);

        uint256 before = vm.snapshotState();
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](12);
        uint256 n;
        for (uint256 i; i < 12; ++i) {
            uint256 id = all[4 + i];
            if (!this.growExt(alice, id, uint256(keccak256(abi.encode("alice", seed, i))), 40)) continue;
            (, uint8 rot,,, int32 x, int32 y,,) = m.parts(id);
            spots[n++] = IdentityMachine.Spot(id, rot, x, y);
        }
        if (n == 0) return;
        assembly ("memory-safe") { mstore(spots, n) }
        Snapshot memory oneByOne = _snap(all);

        vm.revertToState(before);
        uint256 r = _r();
        vm.prank(alice);
        m.build(r, noProofs, noIds, spots);
        Snapshot memory batch = _snap(all);

        assertEq(batch.pot, oneByOne.pot, "pot");
        assertEq(batch.deadline, oneByOne.deadline, "clock");
        assertEq(batch.open, oneByOne.open, "open sockets");
        assertEq(batch.placed, oneByOne.placed, "placed");
        assertEq(int256(batch.minX), int256(oneByOne.minX));
        assertEq(int256(batch.minY), int256(oneByOne.minY));
        assertEq(int256(batch.maxX), int256(oneByOne.maxX));
        assertEq(int256(batch.maxY), int256(oneByOne.maxY));
        assertEq(batch.totalPaid, oneByOne.totalPaid, "paid to parts");
        assertEq(batch.balance, oneByOne.balance, "machine balance");
        assertEq(batch.parts, oneByOne.parts, "a part's credit, earnings, placer or position differs");
        assertEq(batch.order, oneByOne.order, "build order");
    }
}
