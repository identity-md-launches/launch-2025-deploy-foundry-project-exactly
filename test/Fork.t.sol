// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {DrandBeacon, IBeacon} from "../src/DrandBeacon.sol";
import {DeployLib, Config, System} from "../script/Deploy.s.sol";

interface IImdBlocklist {
    function setBlocked(address who, bool blocked) external;
}

interface Ownable {
    function owner() external view returns (address);
}

/// The whole system on a Robinhood Chain mainnet fork: real IMD and live drand.
///   FOUNDRY_PROFILE=fork forge test --match-contract ForkTest --fork-url https://rpc.mainnet.chain.robinhood.com -vv
///   (if that RPC rate-limits forking with a Cloudflare 403, https://robinhood.drpc.org works too)
contract ForkTest is Test {
    IERC20 constant IMD = IERC20(0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127);

    function _sig(uint64 round) internal returns (bytes memory) {
        string[] memory cmd = new string[](3);
        cmd[0] = "bash";
        cmd[1] = "-c";
        cmd[2] = string.concat(
            "u=https://api.drand.sh/v2/beacons/evmnet/rounds/", vm.toString(uint256(round)),
            "; curl -fsS --max-time 10 --retry 10 --retry-delay 3 --retry-all-errors --retry-max-time 90 $u",
            " | python3 -c 'import json,sys;print(\"0x\"+json.load(sys.stdin)[\"signature\"],end=\"\")'"
        );
        return vm.ffi(cmd);
    }

    /// reveal `ids` with the live signature and plug the first part that fits next to the core, in one build
    function _coreExit(uint16 design, uint8 rot, int32 x, int32 y) internal pure returns (IdentityMachine.GrowthExit memory) {
        (uint8 n, int32[9] memory xs, int32[9] memory ys,) = Shapes.footprint(Catalog.tmplOf(design), rot, x, y);
        int32 minX = -1; int32 minY = -1; int32 maxX = 1; int32 maxY = 1;
        for (uint256 i; i < n; ++i) {
            if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
            if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
        }
        if (minY == -1) return IdentityMachine.GrowthExit(0, -1, 1);
        if (maxX == 1) return IdentityMachine.GrowthExit(1, 0, 2);
        if (maxY == 1) return IdentityMachine.GrowthExit(0, 1, 4);
        return IdentityMachine.GrowthExit(-1, 0, 8);
    }

    function _buildAny(IdentityMachine m, address who, uint256[] memory ids, uint64 dr) internal returns (uint256) {
        IdentityMachine.Proof[] memory proofs = new IdentityMachine.Proof[](1);
        proofs[0] = IdentityMachine.Proof(dr, _sig(dr));
        IdentityMachine.Spot[] memory none = new IdentityMachine.Spot[](0);
        vm.prank(who);
        m.build(1, proofs, ids, none, IdentityMachine.GrowthExit(0, -1, 1));
        for (uint256 i; i < ids.length; ++i) {
            (uint16 d,,,,,,,) = m.parts(ids[i]);
            for (uint8 rot; rot < 4; ++rot) {
                for (int32 x = -3; x <= 3; ++x) {
                    for (int32 y = -3; y <= 3; ++y) {
                        try m.check(d, rot, x, y) {
                            IdentityMachine.Spot[] memory s = new IdentityMachine.Spot[](1);
                            s[0] = IdentityMachine.Spot(ids[i], rot, x, y);
                            uint256[] memory noIds = new uint256[](0);
                            IdentityMachine.GrowthExit memory exit = _coreExit(d, rot, x, y);
                            vm.prank(who);
                            m.build(1, new IdentityMachine.Proof[](0), noIds, s, exit);
                            return ids[i];
                        } catch {}
                    }
                }
            }
        }
        return 0;
    }

    function test_onRobinhood() public {
        vm.skip(block.chainid != 4663);
        address alice = makeAddr("alice");
        address dev = makeAddr("dev");
        deal(address(IMD), alice, 1000 ether);

        // 1. the system
        DrandBeacon b = new DrandBeacon();
        System memory s = DeployLib.deploy(
            Config(IMD, IBeacon(address(b)), dev, bytes32(0), 0.10 ether, 0),
            address(this)
        );
        IdentityMachine m = s.machine;

        // 2. alice mints 20, reveals them with live drand and plugs one in; the others stay in her inventory
        vm.startPrank(alice);
        IMD.approve(address(m), type(uint256).max);
        (uint256 first, uint256 total) = m.mint(20, type(uint256).max);
        vm.stopPrank();
        assertEq(m.reserve(), (total * 500) / 10_000, "5% of every mint funds the reserve");
        assertEq(IMD.balanceOf(address(m)), total - (total * 200) / 10_000, "the real token delivered the whole price");
        (, uint48 dr) = m.pending(first);
        uint256[] memory ids = new uint256[](20);
        for (uint256 i; i < 20; ++i) ids[i] = first + i;
        uint256 placedId = _buildAny(m, alice, ids, uint64(dr));
        assertGt(placedId, 0, "plugged a part in");
        assertEq(s.parts.balanceOf(alice), 19, "placing consumed one item");

        // 3. the clock runs out: alice's part was the last placed, so it takes first place: 30% of 70% of the pot
        (,,,,,,,,,,, uint256 pot,,) = m.rounds(1);
        (, uint40 deadline,,,,,,,,,,,,) = m.rounds(1);
        vm.warp(deadline);
        m.endRound();
        assertEq(m.credit(placedId), (((pot * 7000) / 10_000) * 3000) / 10_000);
        assertEq(m.round(), 2);

        // 4. alice claims through the real token and receives exactly what she earned
        uint256 owed = m.earned(placedId);
        uint256 before = IMD.balanceOf(alice);
        uint256[] memory claimIds = new uint256[](1);
        claimIds[0] = placedId;
        vm.prank(alice);
        assertEq(m.claim(claimIds), owed);
        assertEq(IMD.balanceOf(alice) - before, owed, "the real token paid out in full");
    }

    /// A dependency, not a game rule: the live IMD token's owner (one key) keeps a blocklist. A blocked address can
    /// neither send nor receive IMD, so blocking the machine would stop every purchase and claim, and blocking a
    /// player stops their claims. No game contract can prevent it. This test records the behaviour so any change
    /// to the token shows up here.
    function test_imdOwnerBlocklistCanFreezeAHolder() public {
        vm.skip(block.chainid != 4663);
        address owner = Ownable(address(IMD)).owner();
        address holder = makeAddr("holder");
        address other = makeAddr("other");
        deal(address(IMD), holder, 10 ether);
        vm.prank(holder);
        assertTrue(IMD.transfer(other, 1 ether));
        vm.prank(owner);
        IImdBlocklist(address(IMD)).setBlocked(holder, true);
        vm.prank(holder);
        vm.expectRevert();
        IMD.transfer(other, 1 ether);
        vm.prank(other);
        vm.expectRevert();
        IMD.transfer(holder, 1 ether);
    }
}
