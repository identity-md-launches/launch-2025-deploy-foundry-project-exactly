// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine, IParts} from "../../src/IdentityMachine.sol";
import {IBeacon} from "../../src/DrandBeacon.sol";
import {Shapes} from "../../src/Shapes.sol";
import {Base, G} from "../Base.sol";

/// Pure packing harness only; these calls do not demonstrate reachable placements.
contract PackingHarness is IdentityMachine {
    constructor()
        IdentityMachine(
            IERC20(address(0)),
            IBeacon(address(0)),
            address(0),
            bytes32(0),
            1,
            0
        )
    {}

    function key(uint192 r, int32 x, int32 y) external pure returns (uint256) {
        return _key(r, x, y);
    }

    function step(int32 x, int32 y, uint8 direction) external pure returns (int32, int32) {
        return _step(x, y, direction);
    }

    function opposite(uint8 direction) external pure returns (uint8) {
        return _opp(direction);
    }
}

contract SecurityGeometryTest is Base {
    PackingHarness packing;

    function setUp() public override {
        super.setUp();
        packing = new PackingHarness();
    }

    function testFuzz_signedCellKeyHasExactIndependentByteLanes(uint192 r, int32 x, int32 y) public view {
        assertEq(packing.key(r, x, y), uint256(bytes32(abi.encodePacked(r, uint32(x), uint32(y)))));
    }

    function test_realGrowthAcrossSignedCoordinatesDoesNotAliasRounds() public {
        for (int32 x = 2; x <= 66; ++x) {
            uint256 id = _grant(alice, G.PATCH);
            _place(alice, id, 0, x, 0);
        }
        for (int32 x = -2; x >= -66; --x) {
            uint256 id = _grant(bob, G.PATCH);
            _place(bob, id, 0, x, 0);
        }
        for (int32 x = -66; x <= 66; ++x) {
            (bool occupied,,) = m.cellAt(1, x, 0);
            assertTrue(occupied);
        }
        assertEq(_round().open, this.bruteOpenExt(1));
        vm.warp(_round().deadline);
        m.endRound();
        uint256 newId = _grant(carol, G.REEL);
        _place(carol, newId, 0, 2, 0);
        (bool stillThere,,) = m.cellAt(1, -66, 0);
        assertTrue(stillThere, "the archive stays");
        (bool oldOccupied, uint256 oldId,) = m.cellAt(1, 2, 0);
        (bool newOccupied, uint256 foundId,) = m.cellAt(2, 2, 0);
        assertTrue(oldOccupied && newOccupied);
        assertTrue(oldId != foundId);
        assertEq(foundId, newId);
    }

    function test_allTemplateRotationsUseIndependentCoordinateAndDirectionModel() public pure {
        for (uint8 t; t < 12; ++t) {
            (uint8 n, int8[9] memory dx, int8[9] memory dy, uint8[9] memory sockets) = Shapes.template(t);
            assertEq(Shapes.cellCount(t), n);
            for (uint8 rot; rot < 4; ++rot) {
                (uint8 count, int32[9] memory x, int32[9] memory y, uint8[9] memory m) =
                    Shapes.footprint(t, rot, -65, 64);
                assertEq(count, n);
                uint256 exteriorSockets;
                for (uint256 i; i < n; ++i) {
                    int32 rx =
                        rot == 0 ? int32(dx[i]) : rot == 1 ? -int32(dy[i]) : rot == 2 ? -int32(dx[i]) : int32(dy[i]);
                    int32 ry =
                        rot == 0 ? int32(dy[i]) : rot == 1 ? int32(dx[i]) : rot == 2 ? -int32(dy[i]) : -int32(dx[i]);
                    assertEq(x[i], -65 + rx);
                    assertEq(y[i], 64 + ry);
                    uint8 expected;
                    for (uint8 bit; bit < 4; ++bit) {
                        if (sockets[i] & (1 << bit) != 0) expected |= uint8(1 << ((bit + rot) % 4));
                    }
                    assertEq(m[i], expected);
                    for (uint8 bit; bit < 4; ++bit) {
                        if (m[i] & (1 << bit) != 0) ++exteriorSockets;
                    }
                    for (uint256 j; j < i; ++j) {
                        assertTrue(x[i] != x[j] || y[i] != y[j], "distinct cells");
                    }
                }
                assertLe(exteriorSockets, 8, "production payee array capacity");
            }
        }
    }

    function test_everyCellOfMulticellFootprintMustBeWithinBounds() public {
        int32 bound = m.BOUND();
        vm.expectRevert(IdentityMachine.OutOfBounds.selector);
        m.check(G.LONG, 0, bound, 0);
        vm.expectRevert(IdentityMachine.OutOfBounds.selector);
        m.check(G.LONG, 2, -bound, 0);
        vm.expectRevert(IdentityMachine.OutOfBounds.selector);
        m.check(G.LONG, 1, 0, bound);
    }

    function test_directionStepsAndOppositesMatchScreenCoordinates() public view {
        int32[4] memory xs = [int32(3), 4, 3, 2];
        int32[4] memory ys = [int32(-5), -4, -3, -4];
        for (uint8 bit; bit < 4; ++bit) {
            uint8 direction = uint8(1 << bit);
            (int32 x, int32 y) = packing.step(3, -4, direction);
            assertEq(x, xs[bit]);
            assertEq(y, ys[bit]);
            assertEq(packing.opposite(packing.opposite(direction)), direction);
            (x, y) = packing.step(x, y, packing.opposite(direction));
            assertEq(x, 3);
            assertEq(y, -4);
        }
    }
}
