// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../../src/IdentityMachine.sol";
import {Parts} from "../../src/Parts.sol";
import {Base, G} from "../Base.sol";

contract ReceiverBomb {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("receiver must not be called during protocol minting");
    }
}

contract SecurityEconomicsAndItemsTest is Base {
    function _paid(uint256 n) internal {
        while (n != 0) {
            uint256 batch = n > 20 ? 20 : n;
            _mint(bob, batch);
            n -= batch;
        }
    }

    function test_batchCrossingPriceBoundaryMatchesSequentialCostsAndPlugFloors() public {
        _paid(1499);
        uint256 first = m.nextId();
        uint256 expected = m.priceAt(1499) + m.priceAt(1500);
        uint256 snap = vm.snapshotState();
        (, uint256 batchCost) = _mint(alice, 2);
        uint256 a = _plugOf(first);
        uint256 b = _plugOf(first + 1);
        assertEq(batchCost, expected);
        uint256 batchDev = m.devBalance();
        uint256 batchBurn = imd.balanceOf(DEAD);
        uint256 batchHeld = m.reserve() + _round().pot; // matching moves money between the two
        vm.revertToState(snap);
        (, uint256 cost1) = _mint(alice, 1);
        (, uint256 cost2) = _mint(alice, 1);
        assertEq(cost1 + cost2, batchCost);
        assertEq(_plugOf(first), a);
        assertEq(_plugOf(first + 1), b);
        assertApproxEqAbs(m.devBalance(), batchDev, 1);
        assertApproxEqAbs(imd.balanceOf(DEAD), batchBurn, 1);
        assertApproxEqAbs(m.reserve() + _round().pot, batchHeld, 2);
    }

    function test_idSpaceAndPaidPositionsIncludeCoreAndOverdueMints() public {
        (uint256 first,) = _mint(alice, 2);
        assertEq(first, 1);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        vm.prank(alice);
        uint256 core = m.claimAgentCore(1723, proof);
        assertEq(core, 3);
        _paid(1498);
        assertEq(m.minted(), 1500);
        _finish(alice);
        uint256 next = m.nextId();
        assertEq(m.minted(), 1500);
        (uint256 gift,) = _mint(bob, 2);
        assertEq(gift, next);
        (, uint48 dr) = m.pending(gift);
        vm.warp(beacon.timeOf(dr) + 30 days);
        _rig(gift, G.PATCH);
        _rig(gift + 1, G.PATCH);
        m.reveal(_ids(gift + 1, gift));
        assertEq(parts.ownerOf(gift + 1), bob);
        assertEq(m.nextId(), gift + 2);
        assertEq(parts.ownerOf(gift), bob);
    }

    function _prizeCase(uint256 mints, uint256 placed) internal {
        _paid(mints);
        if (placed != 0) _line(alice, placed);
        vm.warp(_round().deadline);
        uint256 pot = _round().pot;
        uint256 reserve0 = m.reserve();
        m.endRound();
        uint256[10] memory split = [uint256(3000), 2000, 1300, 1000, 800, 600, 500, 400, 200, 200];
        uint256 expectedImd;
        uint256 filled = placed < 10 ? placed : 10;
        for (uint256 i; i < filled; ++i) {
            expectedImd += ((pot * 7000 / 10_000) * split[i]) / 10_000;
            assertEq(_placeOf(m.order(1, placed - i)), i + 1);
        }
        assertEq(views.roundInfo(1).prize, expectedImd);
        assertEq(m.reserve(), reserve0);
        assertEq(_round().pot, pot - expectedImd, "30% and unfilled places start the next pot");
    }

    function test_prizeMintThresholdsZeroOne1499_1500_1501() public {
        uint256[5] memory counts = [uint256(0), 1, 1499, 1500, 1501];
        for (uint256 i; i < counts.length; ++i) {
            uint256 snap = vm.snapshotState();
            _prizeCase(counts[i], 1);
            vm.revertToState(snap);
        }
    }

    function test_sparsePrizePlacesAreNotRenormalizedAndEleventhGetsNothing() public {
        uint256[5] memory counts = [uint256(0), 1, 9, 10, 11];
        for (uint256 i; i < counts.length; ++i) {
            uint256 snap = vm.snapshotState();
            _prizeCase(300, counts[i]);
            if (counts[i] == 11) assertEq(_placeOf(m.order(1, 1)), 0);
            vm.revertToState(snap);
        }
    }

    function test_fullRoundWithoutPlacementsPaysNoPrize() public {
        _prizeCase(1500, 0);
    }

    function test_itemsIssueAndConsumeRequireMachine() public {
        uint256 id = _grant(alice, G.CAP);
        vm.expectRevert(Parts.NotMachine.selector);
        parts.mint(alice, id + 100);
        vm.expectRevert(Parts.NotMachine.selector);
        vm.prank(bob);
        parts.burn(id);
        assertEq(parts.totalSupply(), 1);
        assertEq(parts.ownerOf(id), alice);
    }

    function test_failedPartMintDoesNotInflateSupply() public {
        uint256 id = _grant(alice, G.CAP);
        vm.expectRevert();
        vm.prank(address(m));
        parts.mint(bob, id);
        assertEq(parts.totalSupply(), 1);
        assertEq(parts.ownerOf(id), alice);
        vm.expectRevert();
        vm.prank(address(m));
        parts.mint(address(0), id + 1);
        assertEq(parts.totalSupply(), 1);
    }

    function test_issuingPartsDoesNotInvokeReceiverCallbacks() public {
        ReceiverBomb recipient = new ReceiverBomb();
        uint256 id = _grant(address(recipient), G.CAP);
        assertEq(parts.ownerOf(id), address(recipient));
    }

    function test_consumedItemsLeaveInventory() public {
        uint256 id = _grant(alice, G.CAP);
        _place(alice, id, 0, 0, -2);
        vm.expectRevert(Parts.UnknownPart.selector);
        parts.ownerOf(id);
    }

    function test_inventoryAdvertisesNoNftInterfaces() public view {
        (bool ok,) = address(parts).staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x80ac58cd)));
        assertFalse(ok);
    }
}
