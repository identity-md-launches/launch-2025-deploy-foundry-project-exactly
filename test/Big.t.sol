// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MachineViews} from "../src/MachineViews.sol";
import {Base, G} from "./Base.sol";

/// A big machine grown with the real drop odds: the open-socket counter against a cell-by-cell count, the wiring
/// rules on every edge, and an outward socket that survives each build.
contract BigMachineTest is Base {
    function test_bigMachine() public {
        _resetFrontier();
        uint256 placed;
        for (uint256 i; i < 700; ++i) {
            uint256 id = _grant(alice, _drop(i));
            if (this.growExt(alice, id, i, 40)) ++placed;
            if (i % 100 == 99) assertEq(_round().open, this.bruteOpenExt(1), "open-socket counter");
        }
        emit log_named_uint("parts placed", placed);
        assertEq(m.round(), 1, "placements cannot end a round");
        assertEq(_round().open, this.bruteOpenExt(1));
        MachineViews.RoundInfo memory r = views.roundInfo(1);
        emit log_named_uint("open sockets", r.open);
        emit log_named_uint("width", uint256(int256(r.maxX - r.minX + 1)));
        emit log_named_uint("height", uint256(int256(r.maxY - r.minY + 1)));
        assertGt(placed, 300);
    }

    /// the counter is exact at every step on a small machine
    function testFuzz_openCounterIsExact(uint256 seed) public {
        _resetFrontier();
        for (uint256 i; i < 40; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            uint256 id = _grant(alice, _drop(s));
            this.growExt(alice, id, s, 30);
            assertEq(m.round(), 1, "placements cannot end a round");
            assertEq(_round().open, this.bruteOpenExt(1));
        }
        assertGt(views.roundInfo(1).open, 0);
    }
}
