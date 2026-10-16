// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {Base, G} from "./Base.sol";

contract InventoryTest is Base {
    function test_largeMintAndLazyResolutionKeepTheRemainingItems() public {
        (uint256 first,) = _mint(alice, 100);
        assertEq(m.minted(), 100);
        for (uint256 i; i < 100; ++i) {
            (address recipient,) = m.pending(first + i);
            assertEq(recipient, alice);
        }
        _rig(first, G.CAP);
        vm.prank(alice);
        m.build(1, noProofs, _ids(first), _spots1(first, 0, 0, -2));
        assertEq(m.placerOf(first), alice);
        (address spareOwner,) = m.pending(first + 99);
        assertEq(spareOwner, alice);
        vm.expectRevert(Parts.UnknownPart.selector); // consumed by its placement
        _place(alice, first, 0, 1, -2);
    }

    function test_twoHundredItemMintGasAndExactQuote() public {
        uint256 n = m.MAX_BATCH();
        assertEq(n, 200);
        uint256 expected = m.quote(n);
        uint256 before = imd.balanceOf(alice);
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        (uint256 first, uint256 paid) = m.mint(n, expected);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("mint(200) gas", used);
        assertLt(used, 15_000_000);
        assertEq(paid, expected);
        assertEq(before - imd.balanceOf(alice), expected);
        assertEq(m.nextId(), first + n);
        vm.expectRevert(IdentityMachine.BadBatch.selector);
        m.mint(n + 1, type(uint256).max);
    }

    function test_largeMintCannotBypassSlippageLimit() public {
        uint256 quote = m.quote(100);
        uint256 next = m.nextId();
        vm.expectRevert(IdentityMachine.TooExpensive.selector);
        vm.prank(alice);
        m.mint(100, quote - 1);
        assertEq(m.nextId(), next);
        assertEq(m.minted(), 0);
    }

    function test_itemsRemainOwnedAcrossRoundsAndAreConsumedOnce() public {
        uint256 id = _grant(alice, G.CAP);
        vm.warp(_round().deadline);
        m.endRound();
        assertEq(parts.ownerOf(id), alice);
        assertEq(parts.balanceOf(alice), 1);
        vm.expectRevert(IdentityMachine.NotOwner.selector);
        _place(bob, id, 0, 0, -2);
        _place(alice, id, 0, 0, -2);
        assertEq(parts.balanceOf(alice), 0);
        assertEq(parts.totalSupply(), 0);
        assertEq(m.placerOf(id), alice);
    }
}
