// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../../src/IdentityMachine.sol";
import {MachineViews} from "../../src/MachineViews.sol";
import {Base, G} from "../Base.sol";

/// Geometry counterexamples and socket-layout probes. Grants model revealed inventory, not acquisition cost.
/// Existing crosses and tees have the same footprints as the proposed upgraded tees and bends.
contract SecurityRingRecipesTest is Base {
    function test_fourteenCornerSealRejectsAtomically() public {
        _mint(bob, 20);
        uint8[14] memory rotations = [uint8(0), 0, 1, 1, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3];
        int32[14] memory xs = [int32(-2), 0, 2, -1, -2, 1, 2, 2, 0, 2, -2, -1, 1, -2];
        int32[14] memory ys = [int32(0), -2, -1, -2, -2, -2, 1, 0, 2, 2, -1, 2, 2, 1];
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](14);
        for (uint256 i; i < spots.length; ++i) {
            spots[i] = IdentityMachine.Spot(_grant(alice, G.BEND), rotations[i], xs[i], ys[i]);
        }
        uint256 pot = _round().pot;
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        vm.prank(alice);
        m.build(1, noProofs, noIds, spots, IdentityMachine.GrowthExit(0, -1, 1));
        assertEq(m.round(), 1);
        assertEq(_round().open, 12);
        assertEq(_round().placed, 0);
        assertEq(_round().pot, pot);
        assertEq(m.totalWon(), 0);
        assertEq(parts.balanceOf(alice), 14);
        _assertSealed(alice, spots);
    }

    function test_crossesInPlaceOfRingTeesLeaveTwelveOutsideSockets() public {
        _ring(G.CROSS, G.BEND);
        assertEq(m.round(), 1);
        assertEq(_round().open, 12);
        assertEq(_round().placed, 16);
    }

    function test_teesInPlaceOfRingCornersLeaveSixteenOutsideSockets() public {
        _ring(G.CROSS, G.TEE);
        assertEq(m.round(), 1);
        assertEq(_round().open, 16);
        assertEq(_round().placed, 16);
    }

    function test_fourCapsAndRoutingSealAlsoRejects() public {
        uint16[18] memory designs = [
            G.TEE,
            G.TEE,
            G.TEE,
            G.TEE,
            G.PATCH,
            G.TEE,
            G.TEE,
            G.TEE,
            G.TEE,
            G.CAP,
            G.CAP,
            uint16(8),
            8,
            G.PATCH,
            G.CAP,
            8,
            8,
            G.CAP
        ]; // design 8 = uncommon manifold; tee models a bend with a third socket
        uint8[18] memory rotations = [uint8(1), 1, 1, 2, 0, 2, 3, 0, 3, 1, 3, 0, 0, 0, 1, 2, 3, 2];
        int32[18] memory xs = [int32(2), 2, 2, 2, 3, 1, -2, -2, -2, 4, -3, -1, 1, 3, 4, 0, -2, -2];
        int32[18] memory ys = [int32(0), -1, 1, 2, 2, 2, -1, -2, 0, 2, -2, -2, -2, -2, -2, 2, 2, 3];
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](18);
        for (uint256 i; i < spots.length; ++i) {
            spots[i] = IdentityMachine.Spot(_grant(alice, designs[i]), rotations[i], xs[i], ys[i]);
        }
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        vm.prank(alice);
        m.build(1, noProofs, noIds, spots, IdentityMachine.GrowthExit(0, -1, 1));
        assertEq(m.round(), 1);
        assertEq(_round().placed, 0);
        assertEq(_round().open, 12);
        assertEq(parts.balanceOf(alice), 18);
        _assertSealed(alice, spots);
    }

    function _ring(uint16 sideDesign, uint16 cornerDesign) internal {
        uint8[16] memory rotations = [uint8(3), 0, 2, 1, 3, 3, 0, 2, 0, 2, 1, 1, 0, 3, 1, 2];
        int32[16] memory xs = [int32(-2), 0, 0, 2, -2, -2, -1, -1, 1, 1, 2, 2, -2, -2, 2, 2];
        int32[16] memory ys = [int32(0), -2, 2, 0, -1, 1, -2, 2, -2, 2, -1, 1, -2, 2, -2, 2];
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](16);
        for (uint256 i; i < spots.length; ++i) {
            spots[i] =
                IdentityMachine.Spot(_grant(alice, i < 12 ? sideDesign : cornerDesign), rotations[i], xs[i], ys[i]);
        }
        vm.prank(alice);
        m.build(1, noProofs, noIds, spots);
    }
}
