// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local-dev stand-in for IMD. Anyone can mint.
contract DevIMD is ERC20 {
    constructor() ERC20("Identity.md (dev)", "IMD") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}
