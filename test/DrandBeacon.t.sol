// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DrandBeacon} from "../src/DrandBeacon.sol";

/// Real drand evmnet signature, fetched from api.drand.sh on 2026-10-05.
contract DrandBeaconTest is Test {
    function test_verifiesLiveEvmnetRound() public {
        DrandBeacon b = new DrandBeacon();
        bytes memory sig =
            hex"2e6586e88e308d252d93f2775068735df1557cfcd5ab71661abacdddc864147c0fe3c18439c99ee9fb8515d2a908ca08b6e38669272c5699614e517c4ae895d1";
        uint256 g = gasleft();
        bytes32 r = b.prove(21238365, sig);
        emit log_named_uint("drand verify gas", g - gasleft());
        assertEq(r, keccak256(sig));
        assertEq(b.randomness(21238365), r);
        assertEq(b.latest(), 21238365);
        vm.expectRevert(DrandBeacon.InvalidSignature.selector);
        b.prove(21238366, sig);
    }

    function test_roundClock() public {
        DrandBeacon b = new DrandBeacon();
        assertEq(b.roundAt(1727521075), 1);
        assertEq(b.roundAt(1727521076), 2);
        assertEq(b.roundAt(1727521078), 2);
        assertEq(b.roundAt(1727521079), 3);
    }
}

