// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DrandBeacon, IBeacon} from "../src/DrandBeacon.sol";
import {DevIMD} from "../src/dev/DevIMD.sol";
import {DevEthPool} from "../src/dev/DevEthPool.sol";
import {EthMinter, IEthPoolManager, IEthQuoter} from "../src/EthMinter.sol";
import {DeployLib, Config, System} from "./Deploy.s.sol";

/// Local anvil: dev IMD, the real drand beacon and a dev IMD/ETH pool.
/// Seat #1723 is claimable by anvil account 0.
contract DevDeploy is Script {
    function run() external {
        uint256 pk = vm.envOr("PK", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address dev0 = vm.addr(pk);
        vm.startBroadcast(pk);
        DevIMD imd = new DevIMD();
        DrandBeacon b = new DrandBeacon();
        DevEthPool pool = new DevEthPool(imd);
        System memory s = DeployLib.deploy(
            Config({
                imd: IERC20(address(imd)),
                beacon: IBeacon(address(b)),
                dev: dev0,
                seatRoot: keccak256(bytes.concat(keccak256(abi.encode(uint16(1723), dev0)))),
                basePrice: 0.10 ether,
                delay: vm.envOr("DELAY", uint256(0)) // local: open right away unless DELAY is set
            }),
            dev0
        );
        EthMinter ethMinter = new EthMinter(s.machine, IEthPoolManager(address(pool)), IEthQuoter(address(pool)), 10_000, 100);
        vm.stopBroadcast();
        DeployLib.write(s, address(imd), address(b), address(ethMinter), "app/public/deploy.local.json");
    }
}
