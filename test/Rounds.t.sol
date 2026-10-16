// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../src/IdentityMachine.sol";
import {MachineViews} from "../src/MachineViews.sol";
import {Base, G} from "./Base.sol";

/// Rounds: the clock, growth validation, the ten prize places, the reserve and retained inventory.
contract RoundsTest is Base {
    // ------------------------------------------------------------ the clock

    function test_roundStartsWithTwentyFourHours() public view {
        MachineViews.RoundInfo memory r = _round();
        assertEq(r.begin, T0);
        assertEq(r.deadline, T0 + 24 hours);
        assertEq(m.timeLeft(), 24 hours);
    }

    function test_placementAddsThirtySecondsCappedAtTwentyFourHours() public {
        uint256 d0 = _round().deadline;
        uint256 id = _grant(alice, G.CROSS);
        _place(alice, id, 0, 0, -2);
        assertEq(_round().deadline, d0, "a full clock stays full");
        vm.warp(_now() + 1 hours);
        id = _grant(alice, G.CAP);
        _place(alice, id, 0, 0, -3);
        assertEq(_round().deadline, d0 + 30);
        id = _grant(alice, G.CAP);
        _place(alice, id, 2, 0, 2);
        assertEq(_round().deadline, d0 + 60);
    }

    function test_mintingDoesNotMoveTheClock() public {
        uint256 d0 = _round().deadline;
        vm.warp(_now() + 1 hours);
        _mint(alice, 20);
        assertEq(_round().deadline, d0);
    }

    function test_clockEndsTheRound() public {
        uint256[] memory caps = _caps(alice, 0, 3);
        _mint(bob, 20);
        uint256 pot = _round().pot;
        uint256 reserve0 = m.reserve(); // the mints' 5%
        vm.expectRevert(IdentityMachine.RoundRunning.selector);
        m.endRound();
        vm.warp(_round().deadline);
        // nobody can place into a machine whose clock ran out
        uint256 late = _grant(bob, G.CAP);
        vm.prank(bob);
        vm.expectRevert(IdentityMachine.RoundOver.selector);
        m.build(1, noProofs, noIds, _spots1(late, 0, 1, -2));
        m.endRound();
        assertEq(m.round(), 2);
        MachineViews.RoundInfo memory r = views.roundInfo(1);
        assertEq(r.ended, T0 + 24 hours);
        // three places filled: 30 + 20 + 13% of 70%; last placed is first
        uint256 prize = (pot * 7000) / 10_000;
        assertEq(m.credit(caps[2]), (prize * 3000) / 10_000);
        assertEq(m.credit(caps[1]), (prize * 2000) / 10_000);
        assertEq(m.credit(caps[0]), (prize * 1300) / 10_000);
        assertEq(_placeOf(caps[2]), 1);
        assertEq(_placeOf(caps[0]), 3);
        assertApproxEqAbs(r.prize, (prize * 6300) / 10_000, 3);
        assertEq(m.reserve(), reserve0, "the reserve keeps only its own income");
        // the new machine: a fresh core, a full clock, and 30% plus the unfilled places already in its pot
        assertEq(_round().open, 12);
        assertEq(_round().deadline, _now() + 24 hours);
        assertEq(_round().pot, pot - r.prize);
    }

    function test_nextMintEndsAnExpiredRound() public {
        _mint(alice, 20);
        vm.warp(_round().deadline + 5 days);
        assertEq(m.price(), BASE, "the price starts over");
        uint256 pot = _round().pot;
        uint256 reserve0 = m.reserve();
        (uint256 id,) = _mint(bob, 1);
        assertEq(m.round(), 2);
        // no places: the whole pot carried into round 2, then bob's pot money, matched by the reserve, which took his 5%
        uint256 toPot = (BASE * 1500) / 10_000;
        uint256 matched = toPot < reserve0 ? toPot : reserve0;
        // round 2 has no placed parts yet, so the mint's shared income goes to its pot too
        assertEq(_round().pot, pot + toPot + matched + (BASE * 2600) / 10_000);
        assertEq(m.reserve(), reserve0 - matched + (BASE * 500) / 10_000);
        (address owner,) = m.pending(id);
        assertEq(owner, bob);
        assertEq(_round().begin, _now());
    }

    function test_roundWithNoPlacementsCarriesThePot() public {
        (, uint256 total) = _mint(alice, 20);
        uint256 pot = _round().pot;
        vm.warp(_round().deadline);
        m.endRound();
        assertEq(_round().pot, pot, "the whole pot starts round 2");
        assertEq(m.reserve(), (total * 500) / 10_000);
        assertEq(views.roundInfo(1).prize, 0);
    }

    // ------------------------------------------------------------ prizes at clock expiry

    function test_lastTenPlacesPaidOnlyAfterClockExpiry() public {
        _mint(bob, 20);
        uint256 pot = _round().pot;
        uint256 reserve0 = m.reserve();
        uint256[] memory ids = _line(alice, 11);
        uint256 last = _grant(carol, G.PATCH);
        _place(carol, last, 0, 13, 0);
        assertEq(m.round(), 1);
        assertEq(m.credit(last), 0, "placement never finishes a round");
        assertGt(_round().open, 0);
        vm.warp(_round().deadline);
        m.endRound();
        MachineViews.RoundInfo memory r = views.roundInfo(1);
        assertEq(r.ended, r.deadline);
        uint256 prize = pot * 7000 / 10_000;
        assertEq(m.credit(last), prize * 3000 / 10_000);
        assertEq(m.credit(ids[10]), prize * 2000 / 10_000);
        assertEq(m.credit(ids[2]), prize * 200 / 10_000);
        assertEq(m.credit(ids[1]), 0);
        assertEq(r.prize + _round().pot, pot, "the rest starts the next pot");
        assertEq(m.reserve(), reserve0);
        uint256 sum;
        for (uint256 i; i < 10; ++i) sum += m.placeBps(i);
        assertEq(sum, 10_000);
    }

    function test_prizeIsClaimedByThePlacer() public {
        _mint(bob, 20);
        uint256[] memory caps = _finish(alice);
        uint256 e = m.earned(caps[11]);
        assertGt(e, 0);
        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        m.claim(caps);
        uint256 got = imd.balanceOf(alice) - before;
        assertEq(got, views.roundInfo(1).prize, "all ten places, plus no shared income (no mints after placing)");
    }

    function test_buildNeverSkipsAnInvalidTrailingSpot() public {
        uint256 first = _grant(alice, G.PATCH);
        uint256 spare = _grant(alice, G.CAP);
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](2);
        spots[0] = IdentityMachine.Spot(first, 0, 2, 0);
        spots[1] = IdentityMachine.Spot(spare, 0, 5, 5);
        vm.expectRevert(IdentityMachine.NotPlugged.selector);
        vm.prank(alice);
        m.build(1, noProofs, noIds, spots);
        assertEq(m.round(), 1);
        assertEq(_round().placed, 0);
        assertEq(parts.balanceOf(alice), 2);
    }

    function test_buildChecksTheMachineId() public {
        _finish(alice);
        uint256 id = _grant(bob, G.CAP);
        vm.prank(bob);
        vm.expectRevert(IdentityMachine.RoundOver.selector);
        m.build(1, noProofs, noIds, _spots1(id, 0, 0, -2));
        vm.prank(bob);
        m.build(2, noProofs, noIds, _spots1(id, 0, 0, -2));
        assertEq(_machineOf(id), 2);
    }

    /// IM-07 (fixed): someone revealing your mint first no longer breaks your build
    function test_buildSkipsMintsSomeoneElseRevealed() public {
        (uint256 id,) = _mint(alice, 1);
        _rig(id, G.PATCH);
        m.reveal(_ids(id)); // bob, or a bot
        vm.prank(alice);
        m.build(1, noProofs, _ids(id), _spots1(id, 1, 0, -2));
        assertEq(m.placerOf(id), alice);
    }

    function test_revealAndPlaceInOneBuild() public {
        (uint256 id,) = _mint(alice, 1);
        _rig(id, G.PATCH);
        vm.prank(alice);
        m.build(1, noProofs, _ids(id), _spots1(id, 1, 0, -2));
        assertEq(m.placerOf(id), alice);
        assertEq(_plugOf(id), 0);
    }

    // ------------------------------------------------------------ parts carry over

    function test_partsCarryOverToTheNextMachine() public {
        uint256 kept = _get(bob, G.PATCH);
        uint256 plug = _plugOf(kept);
        assertEq(plug, BASE / 2);
        _finish(alice);
        assertEq(m.round(), 2);
        uint256 carried = _round().pot;
        _place(bob, kept, 1, 0, -2);
        assertEq(_machineOf(kept), 2);
        assertEq(_round().pot - carried, plug, "plug-pay from round 1's price, into round 2's core");
    }

    function test_eachMachineIsItsOwnEconomy() public {
        uint256 a = _grant(alice, G.CROSS);
        _place(alice, a, 0, 0, -2);
        _mint(carol, 20);
        uint256 e1 = m.earned(a);
        vm.warp(_round().deadline);
        m.endRound();
        uint256 e2 = m.earned(a); // includes its prize
        uint256 b = _grant(bob, G.CROSS);
        _place(bob, b, 0, 0, -2);
        _mint(carol, 20);
        assertEq(m.earned(a), e2, "round 1's parts stop earning");
        assertGt(m.earned(b), 0);
        assertGt(e2, e1);
        vm.prank(alice);
        m.claim(_ids(a));
        assertEq(m.earned(a), 0);
    }

    function test_finishedMachinesStayInTheArchive() public {
        _finish(alice);
        uint256 id = _grant(bob, G.CAP);
        _place(bob, id, 0, 0, -2);
        MachineViews.RoundInfo[] memory a = views.archive(1, 10);
        assertEq(a.length, 2);
        assertEq(a[0].placed, 12);
        assertEq(a[1].placed, 1);
        assertEq(views.board(1, 1, 50).length, 24);
        (bool o1, uint256 p1,) = m.cellAt(1, 2, 0);
        (bool o2,,) = m.cellAt(2, 2, 0);
        assertTrue(o1);
        assertFalse(o2);
        assertEq(m.placerOf(p1), alice);
        assertEq(a[0].minX, -1);
        assertEq(a[0].maxY, 1);
    }

    // ------------------------------------------------------------ fundPot and the reserve

    function test_fundPotGoesToTheRunningMachineOrTheReserve() public {
        m.fundPot(5 ether);
        assertEq(_round().pot, 5 ether);
        vm.warp(_round().deadline);
        m.fundPot(1 ether);
        assertEq(m.reserve(), 1 ether);
    }

    function test_countdown() public {
        _deployAt(1 days);
        vm.prank(alice);
        imd.approve(address(m), type(uint256).max);
        imd.approve(address(m), type(uint256).max);
        assertEq(_round().begin, T0 + 1 days);
        assertEq(_round().deadline, T0 + 2 days);
        vm.prank(alice);
        vm.expectRevert(IdentityMachine.NotStarted.selector);
        m.mint(1, type(uint256).max);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        vm.prank(alice);
        vm.expectRevert(IdentityMachine.NotStarted.selector);
        m.claimAgentCore(1723, proof);
        uint256 id = _grant(alice, G.CAP);
        vm.prank(alice);
        vm.expectRevert(IdentityMachine.NotStarted.selector);
        m.build(1, noProofs, noIds, _spots1(id, 0, 0, -2));
        m.fundPot(60 ether); // the launch prize
        assertEq(_round().pot, 60 ether);
        vm.warp(T0 + 1 days);
        _mint(alice, 1);
        _place(alice, id, 0, 0, -2);
    }

    function test_noLegendaryGrantEntryPoint() public {
        (bool ok,) = address(m).call(abi.encodeWithSignature("grantLegendary(address)", alice));
        assertFalse(ok);
    }
}
