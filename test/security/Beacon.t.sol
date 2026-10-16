// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DrandBeacon} from "../../src/DrandBeacon.sol";

contract SecurityBeaconTest is Test {
    DrandBeacon beacon;
    uint64 constant ROUND = 21_238_365;
    bytes constant SIG =
        hex"2e6586e88e308d252d93f2775068735df1557cfcd5ab71661abacdddc864147c0fe3c18439c99ee9fb8515d2a908ca08b6e38669272c5699614e517c4ae895d1";

    function setUp() public {
        beacon = new DrandBeacon();
    }

    function test_signatureMustHaveCanonicalLengthOnUncachedRound() public {
        uint256[4] memory lengths = [uint256(0), 1, 63, 65];
        for (uint256 i; i < lengths.length; ++i) {
            vm.expectRevert(bytes("Invalid G1 bytes length"));
            beacon.prove(ROUND, new bytes(lengths[i]));
            assertEq(beacon.randomness(ROUND), bytes32(0));
        }
    }

    function test_appendingBytesCannotChooseDifferentRandomness() public {
        vm.expectRevert(bytes("Invalid G1 bytes length"));
        beacon.prove(ROUND, bytes.concat(SIG, hex"00"));
        assertEq(beacon.randomness(ROUND), bytes32(0));
        assertEq(beacon.prove(ROUND, SIG), keccak256(SIG));
    }

    function test_cachedRoundIsImmutableEvenWithDifferentOrMalformedProof() public {
        bytes32 expected = beacon.prove(ROUND, SIG);
        assertEq(beacon.prove(ROUND, hex""), expected);
        assertEq(beacon.prove(ROUND, abi.encode(uint256(1), uint256(3))), expected);
        assertEq(beacon.randomness(ROUND), expected);
        assertEq(beacon.randomness(ROUND + 1), bytes32(0));
    }

    function test_invalidUncachedPointDoesNotPoisonSubsequentValidProof() public {
        bool succeeded;
        try beacon.prove{gas: 1_000_000}(ROUND, abi.encode(uint256(1), uint256(3))) {
            succeeded = true;
        } catch {}
        assertFalse(succeeded);
        assertEq(beacon.randomness(ROUND), bytes32(0));
        assertEq(beacon.prove(ROUND, SIG), keccak256(SIG));
    }

    function test_infinityPointIsNotAValidSignature() public {
        bool succeeded;
        try beacon.prove{gas: 1_000_000}(ROUND, new bytes(64)) {
            succeeded = true;
        } catch {}
        assertFalse(succeeded);
        assertEq(beacon.randomness(ROUND), bytes32(0));
    }

    /// the same curve point written another way (a coordinate plus the field modulus) or negated must not verify:
    /// otherwise the first prover could choose between two randomness values for one round
    function test_nonCanonicalAndNegatedEncodingsDoNotVerify() public {
        uint256 p = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;
        (uint256 x, uint256 y) = abi.decode(SIG, (uint256, uint256));
        bytes[3] memory other = [abi.encode(x + p, y), abi.encode(x, y + p), abi.encode(x, p - y)];
        for (uint256 i; i < other.length; ++i) {
            bool succeeded;
            try beacon.prove{gas: 2_000_000}(ROUND, other[i]) {
                succeeded = true;
            } catch {}
            assertFalse(succeeded);
            assertEq(beacon.randomness(ROUND), bytes32(0));
        }
        assertEq(beacon.prove(ROUND, SIG), keccak256(SIG));
    }

    function test_clockAtGenesisAndExactPeriodEdges() public view {
        uint256 genesis = beacon.GENESIS();
        assertEq(beacon.roundAt(0), 1);
        assertEq(beacon.roundAt(genesis - 1), 1);
        assertEq(beacon.roundAt(genesis), 1);
        assertEq(beacon.roundAt(genesis + 1), 2);
        assertEq(beacon.roundAt(genesis + 3), 2);
        assertEq(beacon.roundAt(genesis + 4), 3);
        assertEq(beacon.timeOf(1), genesis);
    }

    function test_roundZeroTimestampIsRejected() public {
        vm.expectRevert();
        beacon.timeOf(0);
    }
}
