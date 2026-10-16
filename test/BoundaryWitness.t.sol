// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Production no-seal regressions: explicit witnesses exercise the deployed build ABI.
import {Base, G} from "./Base.sol";
import {IdentityMachine, IParts} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeacon} from "../src/DrandBeacon.sol";

/// TEST ONLY: inject remote-edge states to exercise coordinate limits without growing 100,000 cells.
contract BoundaryFixtureMachine is IdentityMachine {
    constructor(IERC20 token, IBeacon random) IdentityMachine(token, random, address(0xD), bytes32(0), .1 ether, 0) {}
    function fixture(int32 x, int32 y, uint8 mask, int32 minX, int32 minY, int32 maxX, int32 maxY) external {
        cells[_key(1, x, y)] = (1 << 8) | mask;
        Round storage R = rounds[1];
        (R.minX, R.minY, R.maxX, R.maxY) = (minX, minY, maxX, maxY);
    }
}

contract BoundaryWitnessTest is Base {
    function _build(IdentityMachine.Spot[] memory spots, int32 x, int32 y, uint8 direction) internal {
        vm.prank(alice);
        m.build(1, noProofs, noIds, spots, IdentityMachine.GrowthExit(x, y, direction));
    }

    function _midcaps(bool repair) internal returns (IdentityMachine.Spot[] memory spots) {
        spots = new IdentityMachine.Spot[](repair ? 5 : 4);
        spots[0] = IdentityMachine.Spot(_grant(alice, G.CAP), 0, 0, -2);
        spots[1] = IdentityMachine.Spot(_grant(alice, G.CAP), 1, 2, 0);
        spots[2] = IdentityMachine.Spot(_grant(alice, G.CAP), 2, 0, 2);
        spots[3] = IdentityMachine.Spot(_grant(alice, G.CAP), 3, -2, 0);
        if (repair) spots[4] = IdentityMachine.Spot(_grant(alice, G.TEE), 3, 1, -2);
    }

    function test_batchCanRepairAnUnsafeIntermediatePrefix() public {
        IdentityMachine.Spot[] memory spots = _midcaps(true);
        _build(spots, 1, -2, 1);
        assertEq(m.round(), 1);
        assertEq(_round().placed, 5);
        assertEq(parts.balanceOf(alice), 0);
        // Continue from the supplied boundary exit, keeping a new boundary exit.
        uint256 tee = _grant(alice, G.TEE);
        _build(_spots1(tee, 3, 1, -3), 1, -3, 1);
        assertEq(_round().placed, 6);
    }

    function test_fourMidcapsRevertAtomicallyAlthoughEightSocketsRemain() public {
        IdentityMachine.Spot[] memory spots = _midcaps(false);
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(spots, 0, -1, 1); // former core boundary, now inside the larger box
        assertEq(_round().placed, 0);
        assertEq(_round().open, 12);
        assertEq(views.status(alice, noIds).totalWeight, 0);
        assertEq(parts.balanceOf(alice), 4);
        for (uint256 i; i < spots.length; ++i) {
            assertEq(parts.ownerOf(spots[i].id), alice);
            assertEq(_machineOf(spots[i].id), 0);
        }
        _assertSealed(alice, spots);
    }

    /// An occupied edge cell facing outward is not enough: the face itself must be a socket. A cap facing the core
    /// leaves its blank back on the right edge of the box; that blank face can't be a witness.
    function test_blankOutwardFaceOnTheEdgeIsNotAnExit() public {
        uint256 cap = _grant(alice, G.CAP);
        IdentityMachine.Spot[] memory spots = _spots1(cap, 1, 2, 0); // socket W into the core, blank E at maxX
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(spots, 2, 0, 2);
        assertEq(_round().placed, 0);
        _build(spots, 0, -1, 1); // the core's top socket still faces out on the top edge
        assertEq(_round().placed, 1);
    }

    function test_invalidExitDoesNotCommitPlugPayOrClockOrConsumption() public {
        uint256 parent = _grant(alice, G.PATCH);
        _build(_spots1(parent, 0, 2, 0), 2, 0, 2);
        uint256 child = _grantPlug(alice, G.PATCH, .05 ether);
        uint256 oldDeadline = _round().deadline;
        vm.warp(T0 + 60);
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(_spots1(child, 0, 3, 0), 100, 100, 2);
        assertEq(_round().placed, 1);
        assertEq(_round().deadline, oldDeadline);
        assertEq(m.credit(parent), 0);
        assertEq(_plugOf(child), .05 ether);
        assertEq(parts.ownerOf(child), alice);
        assertEq(_machineOf(child), 0);
        _build(_spots1(child, 0, 3, 0), 3, 0, 2);
        assertEq(m.credit(parent), .05 ether);
        assertEq(views.status(alice, noIds).totalWeight, 2);
        assertEq(m.earned(parent), .05 ether);
        assertEq(imd.balanceOf(address(m)), .05 ether);
        vm.prank(alice);
        m.claim(_ids(parent));
        assertEq(imd.balanceOf(address(m)), 0);
    }

    function test_forgedDirectionEmptyCellBlankFaceAndStaleEdgeReject() public {
        uint256 id = _grant(alice, G.PATCH);
        IdentityMachine.Spot[] memory spots = _spots1(id, 0, 2, 0);
        IdentityMachine.GrowthExit[6] memory exits = [
            IdentityMachine.GrowthExit(2, 0, 3),
            IdentityMachine.GrowthExit(2, 0, 0),
            IdentityMachine.GrowthExit(2, 100, 2),
            IdentityMachine.GrowthExit(2, 0, 1),
            IdentityMachine.GrowthExit(1, 0, 2),
            IdentityMachine.GrowthExit(type(int32).max, -1, 1)
        ];
        for (uint256 i; i < exits.length; ++i) {
            vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
            _build(spots, exits[i].x, exits[i].y, exits[i].direction);
            assertEq(_round().placed, 0);
            assertEq(parts.ownerOf(id), alice);
        }
        _build(spots, 2, 0, 2);
    }

    function test_noUnprotectedBuildEntryPoint() public {
        IdentityMachine real = new IdentityMachine(imd, beacon, devAddr, root, BASE, 0);
        (bool ok,) = address(real).call(abi.encodeWithSignature(
            "build(uint256,(uint64,bytes)[],uint256[],(uint256,uint8,int32,int32)[])",
            uint256(1), noProofs, noIds, new IdentityMachine.Spot[](0)));
        assertFalse(ok, "legacy selector cannot bypass witness validation");
        assertEq(real.round(), 1);
    }

    function test_fullSealRevertsAndDoesNotPayPrizes() public {
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](12);
        for (uint256 i; i < 12; ++i) {
            (int32 x, int32 y, uint8 rotation) = _capSpot(i);
            spots[i] = IdentityMachine.Spot(_grant(alice, G.CAP), rotation, x, y);
        }
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(spots, 0, -1, 1);
        assertEq(m.round(), 1);
        assertEq(_round().placed, 0);
        assertEq(parts.balanceOf(alice), 12);
        _assertSealed(alice, spots);
    }

    function test_capOnlyFreezeRevertsEvenThoughOneSocketRemains() public {
        uint8[14] memory templates = [uint8(0), 1, 0, 1, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4];
        uint8[14] memory rotations = [uint8(1), 0, 0, 1, 1, 3, 3, 2, 3, 2, 1, 1, 1, 2];
        int32[14] memory xs = [int32(-1), -1, 0, 1, 1, -2, -2, -1, -2, 0, 2, 2, 2, 1];
        int32[14] memory ys = [int32(-2), -3, -3, -3, -2, -1, 0, 2, 1, 2, -1, 0, 1, 2];
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](14);
        for (uint256 i; i < 14; ++i) {
            uint16 design = templates[i] == 4 ? G.CAP : templates[i] == 1 ? G.BEND : G.PATCH;
            spots[i] = IdentityMachine.Spot(_grant(alice, design), rotations[i], xs[i], ys[i]);
        }
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(spots, 0, -1, 1);
        assertEq(m.round(), 1);
        assertEq(_round().placed, 0);
        assertEq(_round().open, 12);
        assertEq(parts.balanceOf(alice), 14);
        _assertSealed(alice, spots);
    }

    function test_clockStillEndsRoundAndIncomeRemainsClaimable() public {
        uint256 id = _grant(alice, G.PATCH);
        _build(_spots1(id, 0, 2, 0), 2, 0, 2);
        _mint(bob, 20);
        uint256 earnedBefore = m.earned(id);
        assertGt(earnedBefore, 0);
        vm.warp(_round().deadline + 1);
        m.endRound();
        assertEq(m.round(), 2);
        assertGt(m.earned(id), earnedBefore); // funded finishing prize
        uint256 earnedAfter = m.earned(id);
        _mint(bob, 20);
        assertEq(m.earned(id), earnedAfter); // later-round flow does not leak back
        uint256 balanceBefore = imd.balanceOf(alice);
        vm.prank(alice);
        m.claim(_ids(id));
        assertEq(imd.balanceOf(alice) - balanceBefore, earnedAfter);
        assertEq(m.earned(id), 0);
    }

    function test_concurrentBuildMakesAnOldExitStaleWithoutLosingInventory() public {
        uint256 parent = _grant(alice, G.PATCH);
        _build(_spots1(parent, 0, 2, 0), 2, 0, 2);
        uint256 cap = _grant(bob, G.CAP);
        vm.prank(bob);
        m.build(1, noProofs, noIds, _spots1(cap, 1, 3, 0), IdentityMachine.GrowthExit(0, -1, 1));
        uint256 tee = _grant(alice, G.TEE);
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(_spots1(tee, 0, -1, -2), 2, 0, 2);
        assertEq(parts.ownerOf(tee), alice);
        _build(_spots1(tee, 0, -1, -2), -1, -2, 8);
        assertEq(_round().placed, 3);
    }

    function test_fuzzCannotForgeSocketOnInitialCore(int32 x, int32 y, uint8 direction) public {
        bool actual = (direction == 1 && y == -1 && x >= -1 && x <= 1)
            || (direction == 2 && x == 1 && y >= -1 && y <= 1)
            || (direction == 4 && y == 1 && x >= -1 && x <= 1)
            || (direction == 8 && x == -1 && y >= -1 && y <= 1);
        if (!actual) vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        _build(new IdentityMachine.Spot[](0), x, y, direction);
        assertEq(_round().placed, 0);
    }

    function test_fuzzBatchAndOutwardContinuation(uint8 rawLength) public {
        uint256 length = bound(uint256(rawLength), 1, 50);
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](length);
        for (uint256 i; i < length; ++i) {
            spots[i] = IdentityMachine.Spot(_grant(alice, G.PATCH), 0, int32(int256(i + 2)), 0);
        }
        _build(spots, int32(int256(length + 1)), 0, 2);
        uint256 tee = _grant(alice, G.TEE);
        _build(_spots1(tee, 0, int32(int256(length + 2)), 0), int32(int256(length + 2)), 0, 2);
        assertEq(_round().placed, length + 1);
        assertGt(_round().open, 0);
    }

    function test_proofRevealAndAccountingRollBackForInvalidFinalWitness() public {
        (uint256 id,) = _mint(alice, 1);
        (, uint48 dr) = m.pending(id);
        bytes memory sig = hex"aa11223344";
        uint256 roll = uint256(keccak256(abi.encode(keccak256(sig), id)));
        uint8 tier = m.rollTier(roll);
        uint16 design = Catalog.partFor(tier, Shapes.rollDrop(tier, roll >> 16), roll >> 32);
        (bool fits, uint8 rot, int32 x, int32 y) = _findSpot(design);
        assertTrue(fits);
        IdentityMachine.Proof[] memory proofs = new IdentityMachine.Proof[](1);
        proofs[0] = IdentityMachine.Proof(dr, sig);
        IdentityMachine.Spot[] memory spots = _spots1(id, rot, x, y);
        uint256 pot = _round().pot;
        uint256 balance = imd.balanceOf(address(m));
        uint256 deadline = _round().deadline;
        uint256 paid = m.totalPaid();
        vm.warp(T0 + 60);
        vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
        vm.prank(alice);
        m.build(1, proofs, _ids(id), spots, IdentityMachine.GrowthExit(99, 99, 1));
        assertEq(beacon.randomness(dr), 0);
        (address owner,) = m.pending(id);
        assertEq(owner, alice);
        assertEq(parts.balanceOf(alice), 0);
        assertEq(_round().pot, pot);
        assertEq(_round().deadline, deadline);
        assertEq(_round().placed, 0);
        assertEq(m.totalPaid(), paid);
        assertEq(imd.balanceOf(address(m)), balance);
        IdentityMachine.GrowthExit memory exit = m.previewGrowthExit(1, spots, proofs);
        vm.prank(alice);
        m.build(1, proofs, _ids(id), spots, exit);
        assertEq(m.placerOf(id), alice);
        assertEq(beacon.randomness(dr), keccak256(sig));
    }

    function test_cannotRepairDraftWithAnotherPlayersPart() public {
        IdentityMachine.Spot[] memory spots = _midcaps(true);
        spots[4].id = _grant(bob, G.TEE);
        vm.expectRevert(IdentityMachine.NotOwner.selector);
        _build(spots, 1, -2, 1);
        assertEq(_round().placed, 0);
        assertEq(_round().open, 12);
        assertEq(parts.ownerOf(spots[4].id), bob);
    }

    function test_coordinateLimitsRequireAnInBoundsNextCellInEveryDirection() public {
        BoundaryFixtureMachine edge = new BoundaryFixtureMachine(imd, beacon);
        int32 b = edge.BOUND();
        int32[4] memory xs = [int32(0), b, int32(0), -b];
        int32[4] memory ys = [-b, int32(0), b, int32(0)];
        for (uint8 i; i < 4; ++i) {
            uint8 direction = uint8(1 << i);
            int32 x = xs[i]; int32 y = ys[i];
            edge.fixture(x, y, direction, x < -1 ? x : int32(-1), y < -1 ? y : int32(-1), x > 1 ? x : int32(1), y > 1 ? y : int32(1));
            vm.expectRevert(IdentityMachine.NoGrowthExit.selector);
            edge.build(1, noProofs, noIds, new IdentityMachine.Spot[](0), IdentityMachine.GrowthExit(x, y, direction));
            if (i == 0) ++y; else if (i == 1) --x; else if (i == 2) --y; else ++x;
            edge.fixture(x, y, direction, x < -1 ? x : int32(-1), y < -1 ? y : int32(-1), x > 1 ? x : int32(1), y > 1 ? y : int32(1));
            edge.build(1, noProofs, noIds, new IdentityMachine.Spot[](0), IdentityMachine.GrowthExit(x, y, direction));
        }
    }

    function test_repeatingAnItemCannotConsumeItOrPayTwice() public {
        uint256 id = _grantPlug(alice, G.PATCH, .05 ether);
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](2);
        spots[0] = IdentityMachine.Spot(id, 0, 2, 0);
        spots[1] = IdentityMachine.Spot(id, 0, 3, 0);
        vm.expectRevert(Parts.UnknownPart.selector); // the first spot consumed it
        _build(spots, 3, 0, 2);
        assertEq(_round().placed, 0);
        assertEq(_round().pot, 0);
        assertEq(_plugOf(id), .05 ether);
        assertEq(parts.ownerOf(id), alice);
        assertEq(imd.balanceOf(address(m)), .05 ether);
    }

    function test_everyTemplateAndRotationHasAValidInstallationAndContinuation() public {
        uint16[12] memory designs = [G.PATCH, G.BEND, G.TEE, G.CROSS, G.CAP, G.LONG, uint16(8), uint16(12), uint16(13), G.RADAR, G.CONSOLE, G.REACTOR];
        for (uint256 t; t < designs.length; ++t) {
            assertEq(Catalog.tmplOf(designs[t]), t);
            for (uint8 rot; rot < 4; ++rot) {
                uint256 snapshot = vm.snapshotState();
                uint256 spacer = _grant(alice, G.PATCH);
                _build(_spots1(spacer, 0, 2, 0), 2, 0, 2);
                uint256 id = _grant(alice, designs[t]);
                bool installed;
                for (int32 x = -5; x <= 5 && !installed; ++x) {
                    for (int32 y = -5; y <= 5 && !installed; ++y) {
                        try m.check(designs[t], rot, x, y) {
                            IdentityMachine.Spot[] memory spots = _spots1(id, rot, x, y);
                            IdentityMachine.GrowthExit memory exit = m.previewGrowthExit(1, spots, noProofs);
                            if (exit.direction == 0) continue;
                            _build(spots, exit.x, exit.y, exit.direction);
                            _continueFrom(exit);
                            installed = true;
                        } catch {}
                    }
                }
                assertTrue(installed, "template/rotation must remain playable");
                assertTrue(vm.revertToState(snapshot));
            }
        }
    }

    function _continueFrom(IdentityMachine.GrowthExit memory exit) internal {
        int32 x = exit.x + (exit.direction == 2 ? int32(1) : exit.direction == 8 ? int32(-1) : int32(0));
        int32 y = exit.y + (exit.direction == 4 ? int32(1) : exit.direction == 1 ? int32(-1) : int32(0));
        uint8 rot = exit.direction == 1 ? 1 : exit.direction == 2 ? 0 : exit.direction == 4 ? 1 : 0;
        uint256 id = _grant(alice, G.TEE);
        _build(_spots1(id, rot, x, y), x, y, exit.direction);
        assertEq(_round().placed, 3);
        assertGt(_round().open, 0);
    }
}
