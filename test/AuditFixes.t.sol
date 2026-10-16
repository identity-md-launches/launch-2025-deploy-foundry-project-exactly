// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base, G} from "./Base.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeacon} from "../src/DrandBeacon.sol";

/// The swarm audit's three low findings (job 0b474c5e, commit bb0c596), each pinned by the case it reproduced.
contract AuditFixesTest is Base {
    /// L1: a sponsorship sequenced after the round it meant to pay has ended no longer lands in the next pot
    function test_sponsorAfterRolloverReverts() public {
        uint256 id = _grant(alice, G.CAP);
        _place(alice, id, 0, 0, -2);
        vm.warp(_round().deadline);
        m.endRound();
        uint256 pot = _round().pot;
        uint256 earned = m.earned(id);
        vm.expectRevert(IdentityMachine.NothingPlaced.selector);
        m.sponsor(100 ether);
        assertEq(_round().pot, pot);
        assertEq(m.earned(id), earned);
    }

    /// L1: before anything is placed (including the launch countdown), sponsor reverts; fundPot is the pot's door
    function test_sponsorWithNothingPlacedReverts() public {
        vm.expectRevert(IdentityMachine.NothingPlaced.selector);
        m.sponsor(10 ether);
        IdentityMachine later =
            new IdentityMachine(IERC20(address(imd)), IBeacon(address(beacon)), address(0xD), 0, BASE, 48 hours);
        imd.approve(address(later), 10 ether);
        vm.expectRevert(IdentityMachine.NothingPlaced.selector);
        later.sponsor(10 ether);
        later.fundPot(10 ether);
    }

    /// L2: check() agrees with build() once the clock has run out, and answers for the next machine after rollover
    function test_checkFollowsTheClock() public {
        uint256[] memory payees = m.check(G.CAP, 0, 0, -2);
        assertEq(payees.length, 1);
        assertEq(payees[0], 0, "the core");
        vm.warp(_round().deadline - 1);
        m.check(G.CAP, 0, 0, -2);
        vm.warp(_round().deadline);
        vm.expectRevert(IdentityMachine.RoundOver.selector);
        m.check(G.CAP, 0, 0, -2);
        m.endRound();
        assertEq(m.check(G.CAP, 0, 0, -2).length, 1, "the next machine's core");
    }

    /// L3: the constructor itself refuses a zero developer address or a zero base price
    function test_constructorRefusesZeroDevAndZeroPrice() public {
        vm.expectRevert(IdentityMachine.BadConfig.selector);
        new IdentityMachine(IERC20(address(imd)), IBeacon(address(beacon)), address(0), 0, BASE, 0);
        vm.expectRevert(IdentityMachine.BadConfig.selector);
        new IdentityMachine(IERC20(address(imd)), IBeacon(address(beacon)), address(0xD), 0, 0, 0);
    }
}
