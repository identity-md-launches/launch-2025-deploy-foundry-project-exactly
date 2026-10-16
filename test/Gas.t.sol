// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Base, G} from "./Base.sol";

/// Worst cases, for the block (32M) and eth_call (50M) limits. Run with --isolate for per-transaction numbers.
contract GasTest is Base {
    function test_gas_mint20() public {
        _mint(bob, 20); // warm the round
        vm.prank(alice);
        uint256 g = gasleft();
        m.mint(20, type(uint256).max);
        emit log_named_uint("mint(20)", g - gasleft());
    }

    /// reveal 20 mints and plug in 20 parts in one build
    function test_gas_build20() public {
        (uint256 first,) = _mint(alice, 20);
        _rig(first, type(uint16).max);
        uint256[] memory ids = new uint256[](20);
        for (uint256 i; i < 20; ++i) ids[i] = first + i;
        IdentityMachine.Spot[] memory s = new IdentityMachine.Spot[](0);
        vm.prank(alice);
        m.build(1, noProofs, ids, s); // reveal only
        _resetFrontier();
        uint256 g = gasleft();
        uint256 placed;
        for (uint256 i; i < 20; ++i) if (this.growExt(alice, first + i, i, 40)) ++placed;
        emit log_named_uint("placed", placed);
        emit log_named_uint("20 single builds incl. search (upper bound)", g - gasleft());
    }

    /// The most expensive build the 50-part cap allows: 50 Reactors (3x3, eight sockets), each carrying plug-pay.
    /// About 20M gas as its own transaction (--isolate); the client caps a build at 13.5M and asks to remove parts.
    function test_gas_build50Reactors() public {
        uint256[] memory pool = new uint256[](300);
        for (uint256 i; i < 300; ++i) pool[i] = _grantPlug(alice, G.REACTOR, 1 ether);
        _resetFrontier();
        uint256 before = vm.snapshotState();
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](50);
        uint256 n;
        for (uint256 i; i < 300 && n < 50; ++i) {
            if (!this.growExt(alice, pool[i], i, 60)) continue;
            (, uint8 rot,,, int32 x, int32 y,,) = m.parts(pool[i]);
            spots[n++] = IdentityMachine.Spot(pool[i], rot, x, y);
        }
        assertEq(n, 50);
        vm.revertToState(before);
        IdentityMachine.GrowthExit memory exit = m.previewGrowthExit(1, spots, noProofs);
        vm.prank(alice);
        uint256 g = gasleft();
        m.build(1, noProofs, noIds, spots, exit);
        uint256 used = g - gasleft();
        emit log_named_uint("build(50 Reactors)", used);
        assertLt(used, 32_000_000, "fits the block");
    }

    /// Clock end with ten prize places.
    function test_gas_clockEndWithEverything() public {
        for (uint256 i; i < 75; ++i) _mint(bob, 20);
        _line(carol, 12);
        vm.warp(_round().deadline);
        uint256 g = gasleft();
        m.endRound();
        emit log_named_uint("clock end with all prizes", g - gasleft());
    }

    function test_gas_claim100() public {
        uint256[] memory ids = new uint256[](100);
        _resetFrontier();
        uint256 k;
        for (uint256 i; k < 100 && i < 400; ++i) {
            uint256 id = _grant(alice, _drop(i));
            if (this.growExt(alice, id, i, 30)) ids[k++] = id;
        }
        _mint(bob, 20);
        vm.prank(alice);
        uint256 g = gasleft();
        m.claim(ids);
        emit log_named_uint("claim(100)", g - gasleft());
    }
}
