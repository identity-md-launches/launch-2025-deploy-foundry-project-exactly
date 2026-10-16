// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BLS} from "bls-solidity/libraries/BLS.sol";

interface IBeacon {
    /// @return randomness for a drand round, or 0 if not yet proven
    function randomness(uint64 round) external view returns (bytes32);
    function prove(uint64 round, bytes calldata signature) external returns (bytes32);
    /// @return the latest drand round proven so far (0 = none)
    function latest() external view returns (uint64);
    /// @return the first drand round published at or after `timestamp`
    function roundAt(uint256 timestamp) external view returns (uint64);
    /// @return when drand publishes `round`
    function timeOf(uint64 round) external view returns (uint256);
}

/// @notice drand `evmnet` (bls-bn254-unchained-on-g1, 3s period) verified on chain.
///         Anyone may prove a round with its public signature; no relayer, no owner.
contract DrandBeacon is IBeacon {
    uint256 public constant GENESIS = 1727521075;
    uint256 public constant PERIOD = 3;
    string public constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    mapping(uint64 => bytes32) public randomness;
    uint64 public latest;

    event RoundProven(uint64 indexed round, bytes32 randomness);

    error InvalidSignature();

    function publicKey() public pure returns (BLS.PointG2 memory) {
        return BLS.PointG2(
            [
                0x557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f,
                0x7e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382
            ],
            [
                0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b,
                0x95685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6
            ]
        );
    }

    function prove(uint64 round, bytes calldata signature) external returns (bytes32 r) {
        r = randomness[round];
        if (r != 0) return r;
        (bool pairingOk, bool callOk) = BLS.verifySingle(
            BLS.g1Unmarshal(signature),
            publicKey(),
            BLS.hashToPoint(bytes(DST), abi.encodePacked(keccak256(abi.encodePacked(round))))
        );
        if (!(callOk && pairingOk)) revert InvalidSignature();
        r = keccak256(signature);
        randomness[round] = r;
        if (round > latest) latest = round;
        emit RoundProven(round, r);
    }

    function roundAt(uint256 timestamp) external pure returns (uint64) {
        if (timestamp <= GENESIS) return 1;
        return uint64((timestamp - GENESIS + PERIOD - 1) / PERIOD + 1);
    }

    function timeOf(uint64 round) external pure returns (uint256) {
        return GENESIS + (uint256(round) - 1) * PERIOD;
    }
}
