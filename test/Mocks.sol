// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeacon} from "../src/DrandBeacon.sol";

contract MockIMD is ERC20 {
    constructor() ERC20("Identity.md", "IMD") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev Same round clock as DrandBeacon; randomness is set by the test.
contract MockBeacon is IBeacon {
    uint256 public constant GENESIS = 1727521075;
    uint256 public constant PERIOD = 3;
    mapping(uint64 => bytes32) public randomness;
    uint64 public latest;

    function set(uint64 round, bytes32 r) external {
        randomness[round] = r;
        if (r != 0 && round > latest) latest = round;
    }

    function prove(uint64 round, bytes calldata sig) external returns (bytes32 r) {
        r = randomness[round];
        if (r == 0) {
            r = keccak256(sig);
            randomness[round] = r;
            if (round > latest) latest = round;
        }
    }

    function roundAt(uint256 t) external pure returns (uint64) {
        if (t <= GENESIS) return 1;
        return uint64((t - GENESIS + PERIOD - 1) / PERIOD + 1);
    }

    function timeOf(uint64 round) external pure returns (uint256) {
        return GENESIS + (uint256(round) - 1) * PERIOD;
    }
}
