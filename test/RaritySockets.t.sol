// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, G} from "./Base.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Shapes} from "../src/Shapes.sol";

/// More earning opportunities share the same funded plug allocation; no new mint cuts or weights.
contract RaritySocketsTest is Base {
    function test_socketCountsAndOnlyExternalPorts() public pure {
        uint8[12] memory expected = [uint8(2), 2, 3, 4, 1, 2, 4, 4, 4, 5, 6, 8];
        for (uint8 t; t < Shapes.COUNT; ++t) {
            (uint8 n, int8[9] memory xs, int8[9] memory ys, uint8[9] memory masks) = Shapes.template(t);
            uint256 ports;
            for (uint256 i; i < n; ++i) {
                for (uint8 d = 1; d <= 8; d <<= 1) {
                    if (masks[i] & d == 0) continue;
                    ++ports;
                    int8 x = xs[i] + (d == 2 ? int8(1) : d == 8 ? int8(-1) : int8(0));
                    int8 y = ys[i] + (d == 4 ? int8(1) : d == 1 ? int8(-1) : int8(0));
                    for (uint256 j; j < n; ++j) assertFalse(xs[j] == x && ys[j] == y, "no internal phantom port");
                }
            }
            assertEq(ports, expected[t]);
            assertLe(ports, Shapes.MAX_SOCKETS, "fits the eight-entry production payment buffer");
        }
    }

    // A reachable, real installed board surrounds a 3x3 hole. The Reactor then
    // connects all eight ports. No injected cells or mocked wiring/accounting.
    function _ring(uint8 rotation, bool selfOwned) internal returns (uint256[] memory payees, IdentityMachine.Spot memory target) {
        uint8[20] memory ts = [uint8(0),0,0,0,3,0,1,2,3,0,1,2,3,0,1,2,2,0,1,2];
        uint8[20] memory rs = [uint8(0),0,0,0,0,1,0,0,0,0,1,1,0,1,2,2,2,0,3,3];
        int32[20] memory xs = [int32(2),3,4,5,6,6,6,7,8,9,10,10,10,10,10,9,8,7,6,6];
        int32[20] memory ys = [int32(0),0,0,0,0,-1,-2,-2,-2,-2,-2,-1,0,1,2,2,2,2,2,1];
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](20);
        for (uint256 i; i < spots.length; ++i) {
            uint16 design = ts[i] == 0 ? G.PATCH : ts[i] == 1 ? G.BEND : ts[i] == 2 ? G.TEE : G.CROSS;
            address owner = selfOwned ? alice : bob;
            (int32 x, int32 y) = _rotate(xs[i], ys[i], rotation);
            spots[i] = IdentityMachine.Spot(_grant(owner, design), (rs[i] + rotation) % 4, x, y);
        }
        (int32 ex, int32 ey) = _rotate(8, -2, rotation);
        vm.prank(selfOwned ? alice : bob);
        m.build(1, noProofs, noIds, spots, IdentityMachine.GrowthExit(ex, ey, uint8(1 << rotation)));
        (int32 targetX, int32 targetY) = _rotate(7, -1, rotation);
        target = IdentityMachine.Spot(0, rotation, targetX, targetY);
        payees = m.check(G.REACTOR, rotation, targetX, targetY);
        assertEq(payees.length, 8, "all eight sockets connect");
    }

    function _rotate(int32 x, int32 y, uint8 r) internal pure returns (int32, int32) {
        for (uint8 i; i < r; ++i) (x, y) = (-y, x);
        return (x, y);
    }

    function testFuzz_eightIncomingPaymentsConserveFundsAndRemainClaimable(uint96 amount, uint8 rotation) public {
        uint256 plug = bound(amount, 1, 100 ether);
        rotation = uint8(bound(rotation, 0, 3));
        (uint256[] memory payees, IdentityMachine.Spot memory spot) = _ring(rotation, false);
        spot.id = _grantPlug(alice, G.REACTOR, plug);
        vm.prank(alice);
        m.build(1, noProofs, noIds, _spots1(spot.id, spot.rot, spot.x, spot.y));
        uint256 share = plug / 8;
        for (uint256 i; i < payees.length; ++i) assertEq(m.credit(payees[i]), share);
        assertEq(_round().pot, plug % 8, "only rounding dust reaches pot");
        assertEq(_plugOf(spot.id), 0);
        assertEq(views.status(alice, noIds).totalWeight, 40, "20 common supports plus legendary weight 20");
        vm.warp(_round().deadline);
        m.endRound();
        uint256 beforeBalance = imd.balanceOf(bob);
        vm.prank(bob);
        m.claim(payees);
        assertGe(imd.balanceOf(bob) - beforeBalance, share * 8);
        vm.prank(alice);
        m.claim(_ids(spot.id));
        // Small pot dust may award prizes to additional ring supports; claim those too.
        for (uint256 k = 1; k <= 20; ++k) {
            uint256 id = m.order(1, k);
            vm.prank(bob);
            m.claim(_ids(id));
        }
        assertEq(imd.balanceOf(address(m)), m.reserve() + _round().pot, "all receipts paid; reserve and the carried pot fully backed");
    }

    function test_eightLinksCannotCommitThroughAnInvalidWitness() public {
        (uint256[] memory payees, IdentityMachine.Spot memory spot) = _ring(0, false);
        spot.id = _grantPlug(alice, G.REACTOR, 101);
        uint256 deadline = _round().deadline;
        uint256 open = _round().open;
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        vm.prank(alice);
        m.build(1, noProofs, noIds, _spots1(spot.id, 0, spot.x, spot.y), IdentityMachine.GrowthExit(7, -1, 1));
        assertEq(_round().placed, 20);
        assertEq(_round().deadline, deadline);
        assertEq(_round().open, open);
        assertEq(_plugOf(spot.id), 101);
        assertEq(parts.ownerOf(spot.id), alice);
        assertEq(imd.balanceOf(address(m)), 101);
        for (uint256 i; i < payees.length; ++i) assertEq(m.credit(payees[i]), 0);
    }

    function test_eightSelfConnectionsOnlyRecycleTheFundedAllocation() public {
        (uint256[] memory payees, IdentityMachine.Spot memory spot) = _ring(0, true);
        spot.id = _grantPlug(alice, G.REACTOR, .05 ether);
        uint256 beforeBalance = imd.balanceOf(alice);
        vm.prank(alice);
        m.build(1, noProofs, noIds, _spots1(spot.id, 0, spot.x, spot.y));
        vm.prank(alice);
        m.claim(payees);
        assertEq(imd.balanceOf(alice) - beforeBalance, .05 ether);
        assertEq(imd.balanceOf(address(m)), 0);
        assertEq(m.earned(spot.id), 0, "its own carried payment is not new income");
        vm.prank(alice);
        m.claim(payees);
        assertEq(imd.balanceOf(alice) - beforeBalance, .05 ether, "cannot claim twice");
    }
}
