// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, G} from "./Base.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";

contract InstallLimitTest is Base {
    function test_fiftyFundedPartsInstallAndRemainSolventAndClaimable() public {
        uint256 count = m.MAX_BUILD();
        assertEq(count, 50);
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](count);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _grantPlug(alice, G.PATCH, .05 ether);
            spots[i] = IdentityMachine.Spot(ids[i], 0, int32(int256(i + 2)), 0);
        }
        vm.prank(alice);
        uint256 beforeGas = gasleft();
        m.build(1, noProofs, noIds, spots, IdentityMachine.GrowthExit(51, 0, 2));
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("50 funded straight parts execution gas", used);
        assertLt(used, 15_000_000);
        assertEq(_round().placed, count);
        assertEq(parts.balanceOf(alice), 0);
        assertEq(imd.balanceOf(address(m)), .05 ether * count);
        assertEq(_round().pot, .05 ether); // first item's attachment to the core
        uint256 balanceBefore = imd.balanceOf(alice);
        vm.prank(alice);
        m.claim(ids);
        assertEq(imd.balanceOf(alice) - balanceBefore, .05 ether * (count - 1));
        assertEq(imd.balanceOf(address(m)), _round().pot);
        for (uint256 i; i < ids.length; ++i) assertEq(m.earned(ids[i]), 0);
    }

    function test_fiftyOneRejectsBeforeBeaconRevealOrPlacement() public {
        (uint256 pending,) = _mint(alice, 1);
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](51);
        for (uint256 i; i < spots.length; ++i) {
            spots[i] = IdentityMachine.Spot(_grant(alice, G.PATCH), 0, int32(int256(i + 2)), 0);
        }
        IdentityMachine.Proof[] memory proofs = new IdentityMachine.Proof[](1);
        proofs[0] = IdentityMachine.Proof(999, hex"1234");
        uint256 balanceBefore = imd.balanceOf(address(m));
        uint256 deadline = _round().deadline;
        vm.expectRevert(IdentityMachine.BadBuildSize.selector);
        vm.prank(alice);
        m.build(1, proofs, _ids(pending), spots, IdentityMachine.GrowthExit(52, 0, 2));
        assertEq(beacon.randomness(999), bytes32(0));
        assertEq(_round().placed, 0);
        assertEq(_round().open, 12);
        assertEq(_round().deadline, deadline);
        assertEq(imd.balanceOf(address(m)), balanceBefore);
        assertEq(parts.balanceOf(alice), 51);
        (address owner,) = m.pending(pending);
        assertEq(owner, alice);
        for (uint256 i; i < spots.length; ++i) assertEq(parts.ownerOf(spots[i].id), alice);
    }

    function test_mintLimitRemainsTwoHundred() public {
        assertEq(m.MAX_BATCH(), 200);
        (uint256 first,) = _mint(alice, 200);
        assertEq(m.nextId(), first + 200);
    }
}
