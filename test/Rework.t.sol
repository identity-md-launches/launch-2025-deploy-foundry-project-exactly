// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, G} from "./Base.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeacon} from "../src/DrandBeacon.sol";
import {DeployLib, Config, System} from "../script/Deploy.s.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";
import {MockBeacon} from "./Mocks.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {Shapes} from "../src/Shapes.sol";

/// Independent accounting and hostile dependency regressions for the five-contract game.
contract ReworkTest is Base {
    function testFuzz_pendingPurchaseCannotBeCancelledAfterAnyDelay(uint32 elapsed) public {
        (uint256 id, uint256 total) = _mint(alice, 1);
        (, uint48 dr) = m.pending(id);
        uint256 balance = imd.balanceOf(alice);
        uint256 held = imd.balanceOf(address(m));
        vm.warp(beacon.timeOf(dr) + uint256(elapsed));
        vm.prank(alice);
        (bool ok,) = address(m).call(abi.encodeWithSignature("refund(uint256[])", _ids(id)));
        assertFalse(ok);
        assertEq(imd.balanceOf(alice), balance);
        assertEq(imd.balanceOf(address(m)), held);
        assertEq(_plugOf(id), total / 2);
        (address owner, uint48 unchangedRound) = m.pending(id);
        assertEq(owner, alice);
        assertEq(unchangedRound, dr);
    }

    function test_realProofRevealsMonthOldPurchaseAfterRoundEndWithoutRedraw() public {
        uint64 dr = 21_238_365;
        bytes memory sig = hex"2e6586e88e308d252d93f2775068735df1557cfcd5ab71661abacdddc864147c0fe3c18439c99ee9fb8515d2a908ca08b6e38669272c5699614e517c4ae895d1";
        beacon = MockBeacon(address(new DrandBeacon()));
        vm.warp(beacon.timeOf(dr - 3)); // a mint now selects dr (DRAND_MARGIN)
        _deploy();
        vm.prank(alice);
        imd.approve(address(m), type(uint256).max);
        (uint256 id, uint256 total) = _mint(alice, 1);
        (, uint48 selectedRound) = m.pending(id);
        assertEq(selectedRound, dr);
        vm.warp(beacon.timeOf(dr) + 30 days);
        m.endRound();
        vm.prank(bob);
        beacon.prove(dr, sig);
        uint256 held = imd.balanceOf(address(m));
        vm.prank(bob);
        m.reveal(_ids(id));
        uint256 roll = uint256(keccak256(abi.encode(keccak256(sig), id)));
        uint8 tier = m.rollTier(roll);
        assertEq(_design(id), Catalog.partFor(tier, Shapes.rollDrop(tier, roll >> 16), roll >> 32));
        assertEq(parts.ownerOf(id), alice);
        assertEq(_plugOf(id), total / 2);
        assertEq(imd.balanceOf(address(m)), held);
        uint16 design = _design(id);
        m.reveal(_ids(id));
        assertEq(_design(id), design);
        assertEq(parts.totalSupply(), 1);
    }

    function testFuzz_mintAllocationConservesEveryWeiWithReserveMatching(uint96 seedReserve, uint8 count, bool referred, bool placed) public {
        uint256 initial = bound(uint256(seedReserve), 0, 100 ether);
        uint256 n = bound(uint256(count), 1, 20);
        uint256 builder;
        if (placed) {
            builder = _grant(alice, G.PATCH);
            _place(alice, builder, 0, 2, 0);
        }
        m.fundReserve(initial);
        vm.prank(bob);
        (uint256 first, uint256 total) = m.mintWithReferral(n, type(uint256).max, referred ? carol : address(0));
        uint256 plugs;
        for (uint256 i; i < n; ++i) plugs += _plugOf(first + i);
        uint256 toPot = total * 1500 / 10_000;
        uint256 matched = initial < toPot ? initial : toPot;
        uint256 reserveCut = total * 500 / 10_000;
        uint256 burn = total * 200 / 10_000;
        uint256 developer = total * 200 / 10_000;
        uint256 referral = referred ? total * 300 / 10_000 : 0;
        uint256 shared = total - plugs - toPot - reserveCut - burn - developer - referral;
        assertEq(m.reserve(), initial - matched + reserveCut);
        assertEq(_round().pot, toPot + matched + (placed ? 0 : shared));
        assertEq(m.earned(builder), placed ? shared : 0);
        assertEq(m.referralBalance(carol), referral);
        assertEq(m.devBalance(), developer);
        assertEq(imd.balanceOf(DEAD), burn);
        assertEq(imd.balanceOf(address(m)), initial + total - burn);
        assertEq(imd.balanceOf(address(m)), m.reserve() + _round().pot + plugs + m.earned(builder) + developer + referral);
    }

    function test_newReserveCutOnlyMatchesLaterMintPotMoney() public {
        (, uint256 first) = _mint(alice, 1);
        uint256 reserve0 = m.reserve();
        assertEq(reserve0, first * 500 / 10_000);
        assertEq(_round().pot, first - first * 5000 / 10_000 - first * 500 / 10_000 - first * 400 / 10_000);
        uint256 pot0 = _round().pot;
        (, uint256 second) = _mint(bob, 1);
        assertEq(m.reserve(), second * 500 / 10_000);
        uint256 shared = second - second * 5000 / 10_000 - second * 500 / 10_000 - second * 200 / 10_000 * 2 - second * 1500 / 10_000;
        assertEq(_round().pot - pot0, second * 1500 / 10_000 + reserve0 + shared);
    }

    function test_roundSettlementMakesNoDependencyCallsAndEarningsRemainClaimable() public {
        uint256 id = _grant(alice, G.PATCH);
        _place(alice, id, 0, 2, 0);
        _mint(bob, 2);
        uint256 earned0 = m.earned(id);
        uint256 pot = _round().pot;
        bytes memory tokenCode = address(imd).code;
        vm.warp(_round().deadline);
        // Every former settlement dependency now fails if touched.
        vm.etch(address(imd), hex"fe");
        vm.etch(address(parts), hex"fe");
        vm.etch(address(beacon), hex"fe");
        m.endRound();
        uint256 prize = (pot * 7000 / 10_000) * 3000 / 10_000;
        assertEq(m.round(), 2);
        assertEq(m.earned(id), earned0 + prize);
        assertEq(_placeOf(id), 1);
        assertEq(m.leaders(1)[0], id);
        vm.etch(address(imd), tokenCode);
        uint256 balance0 = imd.balanceOf(alice);
        vm.prank(alice);
        assertEq(m.claim(_ids(id)), earned0 + prize);
        assertEq(imd.balanceOf(alice) - balance0, earned0 + prize);
    }





    function test_productionRejectsRemovedGameFeatureSelectors() public {
        System memory s = DeployLib.deploy(Config(IERC20(address(imd)), IBeacon(address(beacon)), devAddr, root, BASE, 0), address(this));
        bytes4[8] memory removed = [bytes4(keccak256("boost(uint256)")), bytes4(keccak256("claimTokens(uint256[])")),
            bytes4(keccak256("harvestTokenDividends()")), bytes4(keccak256("grantLegendary(address)")),
            bytes4(keccak256("flywheel()")), bytes4(keccak256("machines()")),
            bytes4(keccak256("refund(uint256[])")), bytes4(keccak256("REFUND_AFTER()"))];
        for (uint256 i; i < removed.length; ++i) {
            (bool ok,) = address(s.machine).call(abi.encodePacked(removed[i], new bytes(128)));
            assertFalse(ok, "removed entry point must not remain callable");
        }
        assertEq(s.parts.machine(), address(s.machine));
        assertEq(address(s.views.ledger()), address(s.parts));
    }
}
