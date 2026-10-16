// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DevIMD} from "./DevIMD.sol";
import {EthPoolKey, EthSwapParams, EthQuoteParams} from "../EthMinter.sol";

interface IDevUnlock { function unlockCallback(bytes calldata data) external returns (bytes memory); }

/// @dev Local Anvil only: deterministic ETH/IMD liquidity; never use on a public chain.
contract DevEthPool {
    DevIMD public immutable imd;
    uint256 public constant RATE = 0.0035 ether; // ETH per one dev IMD
    address private locker;
    uint256 private owedEth;
    uint256 private owedImd;

    constructor(DevIMD imd_) {
        require(block.chainid == 31337, "local only");
        imd = imd_;
    }

    function poolManager() external view returns (address) { return address(this); }
    function quoteExactOutputSingle(EthQuoteParams calldata p) external view returns (uint256, uint256) {
        _check(p.poolKey);
        require(p.zeroForOne, "ETH to IMD only");
        return (_cost(p.exactAmount), 50_000);
    }
    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(locker == address(0), "locked");
        locker = msg.sender;
        result = IDevUnlock(msg.sender).unlockCallback(data);
        require(owedEth == 0 && owedImd == 0, "unsettled");
        locker = address(0);
    }
    function swap(EthPoolKey calldata key, EthSwapParams calldata p, bytes calldata) external returns (int256) {
        require(msg.sender == locker && locker != address(0), "not locker");
        _check(key);
        require(p.zeroForOne && p.amountSpecified != 0 && owedEth == 0 && owedImd == 0, "bad swap");
        if (p.amountSpecified > 0) { // exact output: IMD
            owedImd = uint256(p.amountSpecified);
            owedEth = _cost(owedImd);
        } else { // exact input: ETH
            owedEth = uint256(-p.amountSpecified);
            owedImd = owedEth * 1 ether / RATE;
        }
        require(owedImd <= uint256(uint128(type(int128).max)) && owedEth <= uint256(uint128(type(int128).max)), "overflow");
        return (int256(-int128(int256(owedEth))) << 128) | int256(uint256(uint128(owedImd)));
    }
    function settle() external payable returns (uint256) {
        require(msg.sender == locker && locker != address(0) && msg.value == owedEth, "bad settlement");
        owedEth = 0;
        return msg.value;
    }
    function take(address currency, address to, uint256 amount) external {
        require(msg.sender == locker && locker != address(0) && currency == address(imd) && amount == owedImd, "bad take");
        owedImd = 0;
        imd.mint(to, amount);
    }
    function _cost(uint256 amount) private pure returns (uint256) { return (amount * RATE + 1 ether - 1) / 1 ether; }
    function _check(EthPoolKey calldata k) private view {
        require(k.currency0 == address(0) && k.currency1 == address(imd) && k.hooks == address(0) && k.fee == 10_000 && k.tickSpacing == 100, "bad pool");
    }
}
