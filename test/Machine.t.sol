// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Parts} from "../src/Parts.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {MachineViews} from "../src/MachineViews.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {Base, G} from "./Base.sol";

/// Minting, reveals, drops, the wiring rules, placement and earnings within one round.
contract MachineTest is Base {
    // ------------------------------------------------------------ price

    function test_quadraticPriceCurve() public view {
        assertEq(m.priceAt(0), BASE);
        assertEq(m.priceAt(1500), 4 * BASE);
        assertEq(m.priceAt(3000), 9 * BASE);
        assertEq(m.priceAt(6000), 25 * BASE);
        assertEq(m.priceAt(750), BASE * 9 / 4);
        uint256 last;
        for (uint256 k; k < 6000; k += 37) {
            uint256 p = m.priceAt(k);
            assertGt(p, last);
            last = p;
        }
    }

    function testFuzz_quadraticPriceIsExactAndAccelerates(uint32 k) public view {
        uint256 scale = m.PRICE_SCALE();
        uint256 n = uint256(k) + scale;
        assertEq(m.priceAt(k), BASE * n * n / (scale * scale));
        assertGt(m.priceAt(uint256(k) + 1), m.priceAt(k));
        assertGt(m.priceAt(uint256(k) + 2) - m.priceAt(uint256(k) + 1), m.priceAt(uint256(k) + 1) - m.priceAt(k));
    }

    function test_quoteSumsPrices() public view {
        uint256 total;
        for (uint256 i; i < 20; ++i) total += m.priceAt(i);
        assertEq(m.quote(20), total);
    }

    // ------------------------------------------------------------ mint

    /// 50% escrow · 26% shared (the pot while nothing is placed) · 15% pot · 5% reserve · 2% burn · 2% dev
    function testFuzz_mintSplitsExactly(uint8 count) public {
        uint256 n = bound(count, 1, 20);
        uint256 quote = m.quote(n);
        uint256 before = imd.balanceOf(alice);
        (uint256 first, uint256 total) = _mint(alice, n);
        assertEq(total, quote);
        assertEq(before - imd.balanceOf(alice), total);
        assertEq(imd.balanceOf(DEAD), (total * 200) / 10_000, "burn 2%");
        assertEq(m.reserve(), (total * 500) / 10_000, "reserve 5% (empty before, so nothing was matched)");
        assertEq(m.devBalance(), (total * 200) / 10_000, "dev 2%");
        uint256 plugs;
        for (uint256 i; i < n; ++i) {
            plugs += _plugOf(first + i);
            assertEq(_plugOf(first + i), m.priceAt(i) / 2);
        }
        // nothing placed yet, so the shared 26% goes to the pot too
        assertEq(_round().pot, total - plugs - (total * 200) / 10_000 * 2 - (total * 500) / 10_000);
        assertEq(imd.balanceOf(address(m)), _round().pot + plugs + m.devBalance() + m.reserve());
    }

    function test_reserveMatchesPotMoneyWhileItLasts() public {
        m.fundReserve(1 ether);
        (, uint256 total) = _mint(alice, 20);
        uint256 toPot = (total * 1500) / 10_000;
        assertEq(m.reserve(), 1 ether - toPot + (total * 500) / 10_000, "matched, then the mint's 5% added");
        // pot: 15% + matched 15% + the shared 26% (nothing placed)
        uint256 shared = total - total / 2 - (total * 200) / 10_000 * 2 - (total * 500) / 10_000 - toPot;
        assertApproxEqAbs(_round().pot, 2 * toPot + shared, 20);
        // a reserve smaller than the pot money gives all it has, then takes this mint's 5%
        uint256 r = m.reserve();
        uint256 pot0 = _round().pot;
        (, uint256 t2) = _mint(alice, 200);
        assertLt(r, (t2 * 1500) / 10_000, "this mint's pot money exceeds the reserve");
        assertEq(m.reserve(), (t2 * 500) / 10_000);
        uint256 plugs2;
        for (uint256 i = 20; i < 220; ++i) plugs2 += m.priceAt(i) / 2;
        uint256 shared2 = t2 - plugs2 - (t2 * 200) / 10_000 * 2 - (t2 * 500) / 10_000 - (t2 * 1500) / 10_000;
        assertEq(_round().pot - pot0, (t2 * 1500) / 10_000 + r + shared2, "matched exactly what the reserve held");
    }

    function test_mintTooExpensiveAndBatchLimits() public {
        vm.startPrank(alice);
        vm.expectRevert(IdentityMachine.TooExpensive.selector);
        m.mint(2, BASE);
        vm.expectRevert(IdentityMachine.BadBatch.selector);
        m.mint(0, type(uint256).max);
        vm.expectRevert(IdentityMachine.BadBatch.selector);
        m.mint(201, type(uint256).max);
        vm.expectRevert(IdentityMachine.BadRecipient.selector);
        m.mintFor(address(0), 1, type(uint256).max);
        vm.stopPrank();
    }

    function test_mintForGivesThePartsToTheRecipient() public {
        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        (uint256 id,) = m.mintFor(bob, 1, type(uint256).max);
        assertEq(before - imd.balanceOf(alice), BASE);
        (address owner,) = m.pending(id);
        assertEq(owner, bob);
    }

    function test_mintRoundIsThreeDrandRoundsAhead() public {
        (uint256 id,) = _mint(alice, 1);
        (, uint48 dr) = m.pending(id);
        assertEq(m.DRAND_MARGIN(), 3);
        assertEq(dr, beacon.roundAt(_now()) + 3);
        assertGe(beacon.timeOf(uint64(dr)), _now() + 9);
    }

    // ------------------------------------------------------------ reveal

    function test_revealIssuesTheItemAndSkipsRevealedMints() public {
        uint256 id = _get(alice, G.RADAR);
        assertEq(parts.totalSupply(), 1);
        (address owner,) = m.pending(id);
        assertEq(owner, address(0));
        m.reveal(_ids(id)); // no-op
        assertEq(parts.totalSupply(), 1);
    }

    function test_revealWaitsForDrand() public {
        (uint256 id,) = _mint(alice, 1);
        vm.expectRevert(IdentityMachine.NotReady.selector);
        m.reveal(_ids(id));
    }

    function test_mintIdIsThePartId() public {
        (uint256 first,) = _mint(alice, 3);
        _rig(first, type(uint16).max);
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) ids[i] = first + i;
        m.reveal(ids);
        for (uint256 i; i < 3; ++i) assertEq(parts.ownerOf(first + i), alice);
        assertEq(m.nextId(), first + 3);
    }

    /// drop odds sum to 1,000 per tier and only use templates that exist in that tier
    function test_dropOddsAreWellFormed() public pure {
        for (uint8 tier; tier < 5; ++tier) {
            uint256 e;
            for (uint8 t; t < Shapes.COUNT; ++t) {
                uint256 a = Shapes.dropOdds(tier, t);
                e += a;
                if (a > 0) assertGt(Catalog.slotSize(tier, t), 0, "a catalog part for every slot");
            }
            assertEq(e, 1000);
        }
    }

    /// the same drop mix all round: caps are 10% of commons
    function test_dropsUseOneMix() public pure {
        uint256 caps;
        uint256 n = 8000;
        for (uint256 i; i < n; ++i) {
            if (Shapes.rollDrop(0, uint256(keccak256(abi.encode(i)))) == Shapes.CAP) ++caps;
        }
        assertApproxEqAbs(caps, (n * 100) / 1000, n / 40);
    }

    // ------------------------------------------------------------ placing

    function test_placingConsumesTheItemAndRecordsThePlacer() public {
        uint256 id = _grant(alice, G.CAP);
        assertEq(parts.totalSupply(), 1);
        _place(alice, id, 0, 0, -2);
        assertEq(parts.totalSupply(), 0);
        vm.expectRevert(Parts.UnknownPart.selector);
        parts.ownerOf(id);
        assertEq(m.placerOf(id), alice);
        assertEq(_machineOf(id), 1);
        (bool occupied, uint256 pid, uint8 sockets) = m.cellAt(1, 0, -2);
        assertTrue(occupied);
        assertEq(pid, id);
        assertEq(sockets, Shapes.S);
    }

    function test_onlyTheOwnerPlaces() public {
        uint256 id = _grant(alice, G.CAP);
        vm.expectRevert(IdentityMachine.NotOwner.selector);
        _place(bob, id, 0, 0, -2);
        _place(alice, id, 0, 0, -2);
        vm.expectRevert(Parts.UnknownPart.selector); // consumed: nobody owns it
        _place(alice, id, 0, 1, -2);
    }

    function test_wiringRules() public {
        uint256 cap = _grant(alice, G.CAP);
        uint256 patch = _grant(alice, G.PATCH);
        vm.expectRevert(IdentityMachine.Occupied.selector);
        _place(alice, cap, 0, 0, 0); // the core
        vm.expectRevert(IdentityMachine.NotPlugged.selector);
        _place(alice, cap, 0, 6, 6);
        vm.expectRevert(IdentityMachine.Mismatch.selector);
        _place(alice, patch, 0, 0, -2); // a blank edge on the core's socket
        vm.expectRevert(IdentityMachine.Mismatch.selector);
        _place(alice, cap, 1, 0, -2); // socket facing W, blank facing the core's socket
        vm.expectRevert(IdentityMachine.BadRot.selector);
        _place(alice, cap, 4, 0, -2);
        vm.expectRevert(IdentityMachine.OutOfBounds.selector);
        _place(alice, cap, 0, 100_001, 0);
        _place(alice, cap, 0, 0, -2);
    }

    /// the core is 3×3 with twelve sockets: two on each corner, one in the middle of each side
    function test_coreHasTwelveSockets() public view {
        assertEq(_r(), m.round());
        assertEq(_round().open, 12);
        uint256 sockets;
        for (int32 x = -1; x <= 1; ++x) {
            for (int32 y = -1; y <= 1; ++y) {
                (bool occ, uint256 pid, uint8 s) = m.cellAt(1, x, y);
                assertTrue(occ);
                assertEq(pid, 0);
                for (uint8 b = s; b > 0; b >>= 1) sockets += b & 1;
            }
        }
        assertEq(sockets, 12);
        (bool o,,) = m.cellAt(1, 2, 0);
        assertFalse(o);
    }

    // ------------------------------------------------------------ plug-pay and shared earnings

    function test_plugPayIntoTheCorePaysThePot() public {
        uint256 id = _grantPlug(alice, G.CAP, 1 ether);
        uint256 pot = _round().pot;
        _place(alice, id, 0, 0, -2);
        assertEq(_round().pot, pot + 1 ether);
        assertEq(_plugOf(id), 0);
    }

    /// a bend at (1, -2) plugs into alice's cross (W) and the core (S): half each, the dust to the pot
    function test_plugPayIntoPartsSplitsEqually() public {
        uint256 a = _grant(alice, G.CROSS);
        _place(alice, a, 0, 0, -2);
        uint256 b = _grantPlug(bob, G.BEND, 1 ether + 1);
        uint256 pot = _round().pot;
        _place(bob, b, 1, 1, -2);
        assertEq(m.credit(a), 0.5 ether);
        assertEq(m.earned(a), 0.5 ether);
        assertEq(_round().pot, pot + 0.5 ether + 1);
        assertEq(m.totalPaid(), 0.5 ether);
        uint256[] memory payees = m.check(G.BEND, 0, -1, -2); // the mirror spot: alice's cross (E) and the core (S)
        assertEq(payees.length, 2);
        assertEq(payees[0] + payees[1], a);
    }

    /// every placed part shares 26% of every later mint of its round, by rarity weight (common 1, legendary 20)
    function test_sharedEarningsByWeight() public {
        uint256 c = _grant(alice, G.CAP);
        _place(alice, c, 0, 0, -2);
        uint256 l = _grant(bob, G.CONSOLE);
        _placeAnywhere(bob, l);
        assertEq(m.weightOf(G.CONSOLE), 20);
        // Plug escrow rounds down for each item; batch fee cuts round down on the total.
        // Quadratic prices can be odd wei, so half the batch total overstates plug escrow.
        uint256 plugs;
        uint256 k = _round().minted;
        for (uint256 i; i < 20; ++i) plugs += m.priceAt(k + i) / 2;
        uint256 paidBefore = m.totalPaid();
        (, uint256 total) = _mint(carol, 20);
        uint256 shared = total - plugs - (total * 200) / 10_000 * 2 - (total * 500) / 10_000 - (total * 1500) / 10_000;
        assertEq(m.totalPaid() - paidBefore, shared);
        assertApproxEqAbs(m.earned(c) + m.earned(l), shared, 2);
        assertApproxEqAbs(m.earned(l), 20 * m.earned(c), 21);
    }

    function test_noEarningsBeforePlacing() public {
        uint256 id = _grant(alice, G.CAP);
        _mint(bob, 20);
        assertEq(m.earned(id), 0);
        _place(alice, id, 0, 0, -2);
        assertEq(m.earned(id), 0, "only later mints");
        _mint(bob, 1);
        assertGt(m.earned(id), 0);
    }

    function test_claimPaysThePlacerOnce() public {
        uint256 a = _grant(alice, G.CROSS);
        _place(alice, a, 0, 0, -2);
        _mint(bob, 20);
        uint256 e = m.earned(a);
        assertGt(e, 0);
        vm.prank(bob);
        vm.expectRevert(IdentityMachine.NotOwner.selector);
        m.claim(_ids(a));
        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        m.claim(_ids(a, a)); // a duplicate id pays nothing twice
        assertEq(imd.balanceOf(alice) - before, e);
        assertEq(m.earned(a), 0);
    }

    function test_itemsCannotBeTransferredAndOnlyTheirRecipientCanPlace() public {
        uint256 id = _grantPlug(alice, G.CAP, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(parts).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, id));
        assertFalse(ok);
        assertEq(parts.ownerOf(id), alice);
        vm.expectRevert(IdentityMachine.NotOwner.selector);
        _place(bob, id, 0, 0, -2);
        _place(alice, id, 0, 0, -2);
        assertEq(m.placerOf(id), alice);
    }

    function test_sponsorPaysTheRunningMachine() public {
        uint256 a = _grant(alice, G.CAP);
        _place(alice, a, 0, 0, -2);
        m.sponsor(3 ether);
        assertApproxEqAbs(m.earned(a), 3 ether, 1);
    }

    function test_sponsorBeforeAnyPartReverts() public {
        vm.expectRevert(IdentityMachine.NothingPlaced.selector);
        m.sponsor(3 ether);
        assertEq(_round().pot, 0);
    }

    function test_payDev() public {
        _mint(alice, 20);
        uint256 d = m.devBalance();
        m.payDev();
        assertEq(imd.balanceOf(devAddr), d);
        assertEq(m.devBalance(), 0);
    }

    // ------------------------------------------------------------ Agent Cores

    function test_agentCoreClaim() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        vm.prank(alice);
        uint256 id = m.claimAgentCore(1723, proof);
        assertEq(parts.ownerOf(id), alice);
        assertEq(_design(id), G.AGENT_CORE);
        assertEq(m.weightOf(G.AGENT_CORE), 1);
        assertEq(_plugOf(id), 0);
        vm.prank(alice);
        vm.expectRevert(IdentityMachine.SeatClaimed.selector);
        m.claimAgentCore(1723, proof);
        vm.prank(carol);
        vm.expectRevert(IdentityMachine.BadProof.selector);
        m.claimAgentCore(7, proof);
        _placeAnywhere(alice, id);
        assertEq(m.placerOf(id), alice);
    }

    // ------------------------------------------------------------ views

    function test_viewsStatusBoardInventoryPending() public {
        uint256 a = _grant(alice, G.CROSS);
        uint256 b = _grant(alice, G.CAP);
        _place(alice, a, 0, 0, -2);
        (uint256 p,) = _mint(alice, 2);
        MachineViews.Status memory s = views.status(alice, _ids(a));
        assertEq(s.round, 1);
        assertEq(s.placed, 1);
        assertEq(s.open, 12 + 4 - 2);
        assertEq(s.roundMinted, 2);
        assertEq(s.inventory, 1);
        assertEq(s.earned, m.earned(a));
        assertEq(s.price, m.priceAt(2));

        uint256[] memory w = views.board(1, 1, 10);
        assertEq(w.length, 2);
        assertEq(address(uint160(w[0])), alice);
        assertEq(uint16(w[0] >> 160), G.CROSS);
        assertEq(uint64(w[1]), a);
        assertEq(int32(uint32(w[1] >> 64)), 0);
        assertEq(int32(uint32(w[1] >> 96)), -2);

        (uint256[] memory ids, uint16[] memory designs,,) = views.inventory(alice, 1, 100);
        assertEq(ids.length, 1);
        assertEq(ids[0], b);
        assertEq(designs[0], G.CAP);

        (uint256[] memory pend,) = views.pendingOf(alice, 1, 100);
        assertEq(pend.length, 2);
        assertEq(pend[0], p);

        (uint256[] memory claimIds, uint256 total) = views.claimable(alice, _ids(a, b));
        assertEq(claimIds.length, 1);
        assertEq(total, m.earned(a));
    }
}
