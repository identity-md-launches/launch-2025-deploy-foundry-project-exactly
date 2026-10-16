// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockIMD} from "../Mocks.sol";
import {Base, G} from "../Base.sol";

/// Assumption stress fixtures: production IMD is a fixed, ordinary ERC-20.
contract NoReturnIMD is MockIMD {
    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        assembly { return(0, 0) }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        assembly { return(0, 0) }
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        super.approve(spender, amount);
        assembly { return(0, 0) }
    }
}

contract FalseReturnIMD is MockIMD {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        return false;
    }
}

contract SecurityTokenCompatibilityTest is Base {
    function test_noReturnTransfersSupportMintClaimAndFunding() public {
        vm.etch(address(imd), address(new NoReturnIMD()).code);
        uint256 id = _get(alice, G.PATCH);
        _place(alice, id, 1, 0, -2);
        m.sponsor(101);
        vm.prank(alice);
        assertEq(m.claim(_ids(id)), 101);
        vm.warp(_now() + 3);
        (uint256 pending,) = _mint(bob, 1);
        (, uint48 dr) = m.pending(pending);
        vm.warp(beacon.timeOf(dr) + 30 days);
        _rig(pending, G.PATCH);
        m.reveal(_ids(pending));
        assertEq(parts.ownerOf(pending), bob);
        uint256 reserve = m.reserve();
        m.fundReserve(5 ether);
        assertEq(m.reserve() - reserve, 5 ether);
    }

    function test_falseReturnTransferRollsBackTokenMutationAndPendingMint() public {
        vm.etch(address(imd), address(new FalseReturnIMD()).code);
        uint256 before = imd.balanceOf(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(imd)));
        vm.prank(alice);
        m.mint(1, BASE);
        assertEq(imd.balanceOf(alice), before);
        assertEq(imd.balanceOf(address(m)), 0);
        assertEq(m.nextId(), 1);
        assertEq(m.minted(), 0);
        (address owner,) = m.pending(1);
        assertEq(owner, address(0));
        vm.etch(address(imd), address(new MockIMD()).code);
        _mint(alice, 1);
        assertEq(m.minted(), 1);
    }
}
