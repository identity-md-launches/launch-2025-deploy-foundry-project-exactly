// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Base, G} from "./Base.sol";

contract ReferralsTest is Base {
    function _pot() internal view returns (uint256 pot) {
        (,,,,,,,,,,, pot,,) = m.rounds(m.round());
    }

    function _deadline() internal view returns (uint256 deadline) {
        (, uint40 d,,,,,,,,,,,,) = m.rounds(m.round());
        return d;
    }

    function testFuzz_referralOnlyReroutesSharedAndAllFeesAreHeld(uint8 count) public {
        uint256 n = bound(count, 1, 200);
        uint256 id = _grant(alice, G.CROSS);
        _place(alice, id, 0, 0, -2);
        uint256 snap = vm.snapshotState();
        uint256 total = m.quote(n);
        vm.prank(bob);
        (uint256 first,) = m.mint(n, total);
        uint256 regularIncome = m.earned(id);
        uint256 regularPot = _pot();
        uint256 regularBalance = imd.balanceOf(address(m));
        uint256 toReserve = m.reserve();
        uint256 burn = imd.balanceOf(DEAD);
        uint256 developer = m.devBalance();
        assertTrue(vm.revertToState(snap));
        vm.prank(bob);
        (uint256 referredFirst, uint256 paid) = m.mintWithReferral(n, total, carol);
        uint256 reward = total * m.REFERRAL() / m.BPS();
        assertEq(referredFirst, first);
        assertEq(paid, total);
        assertEq(m.referralBalance(carol), reward);
        assertEq(m.earned(id) + reward, regularIncome);
        assertEq(_pot(), regularPot);
        assertEq(imd.balanceOf(address(m)), regularBalance);
        assertEq(m.reserve(), toReserve);
        assertEq(imd.balanceOf(DEAD), burn);
        assertEq(m.devBalance(), developer);
        uint256 plugs;
        for (uint256 i; i < n; ++i) {
            plugs += _plugOf(first + i);
        }
        assertEq(plugs + m.earned(id) + reward + _pot() + toReserve + burn + developer, total);
    }

    function test_withoutBuildersUnassignedSharedGoesToPot() public {
        uint256 total = m.quote(1);
        vm.prank(alice);
        m.mintWithReferral(1, total, bob);
        assertEq(m.referralBalance(bob), total * 300 / 10_000);
        assertEq(_pot(), total * (2600 + 1500 - 300) / 10_000);
    }

    function test_invalidReferralsKeepFullSharedAllocation() public {
        address[3] memory invalid = [address(0), address(m), DEAD];
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < invalid.length; ++i) {
            uint256 total = m.quote(1);
            vm.prank(alice);
            m.mintForWithReferral(bob, 1, total, invalid[i]);
            assertEq(m.referralBalance(invalid[i]), 0);
            assertEq(_pot(), total * (2600 + 1500) / 10_000);
            assertTrue(vm.revertToState(snap));
            snap = vm.snapshotState();
        }
    }

    function test_giftReferralAndClaimsBelongToCorrectWallets() public {
        uint256 total = m.quote(3);
        vm.prank(alice);
        (uint256 first,) = m.mintForWithReferral(bob, 3, total, carol);
        (address owner,) = m.pending(first);
        assertEq(owner, bob);
        uint256 reward = total * 300 / 10_000;
        vm.prank(bob);
        assertEq(m.claimReferral(), 0, "recipient cannot take the referrer's credit");
        uint256 before = imd.balanceOf(carol);
        vm.prank(carol);
        assertEq(m.claimReferral(), reward);
        assertEq(imd.balanceOf(carol), before + reward);
        assertEq(m.referralBalance(carol), 0);
        vm.prank(carol);
        assertEq(m.claimReferral(), 0, "no double claim");
    }

    function testFuzz_selfReferralAndSecondWalletHaveIdenticalCombinedReturn(uint8 count) public {
        uint256 n = bound(count, 1, 200);
        uint256 total = m.quote(n);
        uint256 beforeAlice = imd.balanceOf(alice);
        uint256 beforeBob = imd.balanceOf(bob);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        m.mintWithReferral(n, total, alice);
        vm.prank(alice);
        uint256 direct = m.claimReferral();
        uint256 selfCost = beforeAlice - imd.balanceOf(alice);
        uint256 selfPot = _pot();
        uint256 selfEscrow = imd.balanceOf(address(m));
        assertEq(direct, total * 300 / 10_000);
        assertTrue(vm.revertToState(snap));
        vm.prank(alice);
        m.mintWithReferral(n, total, bob);
        vm.prank(bob);
        uint256 second = m.claimReferral();
        assertEq(second, direct);
        assertEq(beforeAlice + beforeBob - imd.balanceOf(alice) - imd.balanceOf(bob), selfCost);
        assertEq(_pot(), selfPot);
        assertEq(imd.balanceOf(address(m)), selfEscrow);
    }

    function test_giftMayReferPayerOrRecipient() public {
        uint256 total = m.quote(1);
        vm.prank(alice);
        m.mintForWithReferral(bob, 1, total, alice);
        assertEq(m.referralBalance(alice), total * 300 / 10_000);
        total = m.quote(1);
        vm.prank(alice);
        m.mintForWithReferral(bob, 1, total, bob);
        assertEq(m.referralBalance(bob), total * 300 / 10_000);
    }

    function test_creditSurvivesRoundsAndNoReferralDoesNotRememberOldAddress() public {
        uint256 total = m.quote(2);
        vm.prank(alice);
        m.mintWithReferral(2, total, bob);
        uint256 reward = total * 300 / 10_000;
        vm.warp(_deadline());
        m.endRound();
        uint256 nextPrice = m.quote(1);
        vm.prank(alice);
        m.mint(1, nextPrice);
        assertEq(m.referralBalance(bob), reward);
        vm.prank(bob);
        assertEq(m.claimReferral(), reward);
    }

    function test_overduePendingMintKeepsPlugAndReferralRemainsFunded() public {
        uint256 total = m.quote(1);
        vm.prank(alice);
        (uint256 first,) = m.mintWithReferral(1, total, bob);
        (, uint48 dr) = m.pending(first);
        vm.warp(beacon.timeOf(dr) + 30 days);
        assertEq(_plugOf(first), total / 2);
        (address owner,) = m.pending(first);
        assertEq(owner, alice);
        vm.prank(bob);
        assertEq(m.claimReferral(), total * 300 / 10_000);
        assertEq(imd.balanceOf(address(m)), m.reserve() + m.devBalance() + _pot() + _plugOf(first));
    }

    function test_failedPaymentAndPriceLimitDoNotCreditReferral() public {
        uint256 total = m.quote(1);
        vm.expectRevert(IdentityMachine.TooExpensive.selector);
        vm.prank(alice);
        m.mintWithReferral(1, total - 1, bob);
        vm.prank(alice);
        imd.approve(address(m), 0);
        vm.expectRevert();
        vm.prank(alice);
        m.mintWithReferral(1, total, bob);
        assertEq(m.referralBalance(bob), 0);
        assertEq(m.nextId(), 1);
    }
}
