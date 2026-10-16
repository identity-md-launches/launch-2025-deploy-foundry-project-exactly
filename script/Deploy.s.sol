// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine, IParts} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {MachineViews} from "../src/MachineViews.sol";
import {DrandBeacon, IBeacon} from "../src/DrandBeacon.sol";
import {EthMinter, IEthPoolManager, IEthQuoter} from "../src/EthMinter.sol";

struct Config {
    IERC20 imd;
    IBeacon beacon;
    address dev;
    bytes32 seatRoot;
    uint256 basePrice; // first mint of every round; smooth quadratic growth
    uint256 delay; // seconds from deployment until minting opens (0 = right away)
}

struct System {
    IdentityMachine machine;
    Parts parts;
    MachineViews views;
}

/// @notice The machine (which creates its inventory ledger) and the views. The swarm deploys the same contracts
///         from launch.json; this library is for scripted and fork deployments.
library DeployLib {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function check(Config memory c) internal view {
        require(c.delay <= 30 days, "DELAY: seconds, at most 30 days");
        require(c.basePrice > 0, "base price");
        require(c.dev != address(0), "dev address");
        require(address(c.imd).code.length > 0 && address(c.beacon).code.length > 0, "imd and beacon must exist");
    }

    function deploy(Config memory c, address deployer) internal returns (System memory s) {
        check(c);
        s.machine = new IdentityMachine(c.imd, c.beacon, c.dev, c.seatRoot, c.basePrice, c.delay);
        s.parts = Parts(address(s.machine.inventory()));
        s.views = new MachineViews(s.machine);
    }

    function write(System memory s, address imd, address beacon, address ethMinter, string memory path) internal {
        string memory j = "deploy";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "imd", imd);
        vm.serializeAddress(j, "beacon", beacon);
        vm.serializeAddress(j, "parts", address(s.parts));
        vm.serializeAddress(j, "views", address(s.views));
        vm.serializeUint(j, "start", s.machine.start());
        vm.serializeAddress(j, "ethMinter", ethMinter);
        string memory out = vm.serializeAddress(j, "machine", address(s.machine));
        vm.writeJson(out, path);
    }
}

/// @notice Robinhood Chain mainnet, from your EOA:
///   forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --interactives 1
///   (optional env: DEV=<payout address>, defaults to the deploying EOA)
contract DeployScript is Script {
    address public constant IMD = 0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127;
    bytes32 public constant SEAT_ROOT = 0x17e6c249305f1a38b59d858e952c4b415c3f2bf38b0b2f71260e3d343a55c738; // Ethereum block 26132002
    // Uniswap official Robinhood deployments; live exact-output quote verified 2026-10-07.
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    uint24 public constant POOL_FEE = 10_000;
    uint24 public constant TICK_SPACING = 100;
    uint256 public constant BASE_PRICE = 0.10 ether; // 0.10 IMD; price = base * (1 + round mints / 1,500)^2
    uint256 public constant COUNTDOWN = 48 hours; // launch.json carries the same values for the swarm deployment

    function run() external returns (System memory s) {
        require(block.chainid == 4663, "Robinhood Chain only");
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        DrandBeacon b = new DrandBeacon();
        Config memory c = Config({
            imd: IERC20(IMD),
            beacon: IBeacon(address(b)),
            dev: vm.envOr("DEV", deployer),
            seatRoot: SEAT_ROOT,
            basePrice: BASE_PRICE,
            delay: vm.envOr("DELAY", COUNTDOWN) // the launch countdown; DELAY=<seconds> to choose
        });
        s = DeployLib.deploy(c, deployer);
        EthMinter ethMinter = new EthMinter(s.machine, IEthPoolManager(POOL_MANAGER), IEthQuoter(QUOTER), POOL_FEE, TICK_SPACING);
        vm.stopBroadcast();
        ethMinter.quote(1); // abort deployment simulation if the configured pool cannot quote
        console.log("DrandBeacon", address(b));
        console.log("IdentityMachine", address(s.machine));
        console.log("Parts", address(s.parts));
        console.log("MachineViews", address(s.views));
        console.log("EthMinter", address(ethMinter));
        console.log("minting opens at (unix)", s.machine.start());
        // only a real deployment writes the site's manifest: a dry run's addresses don't exist on chain
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            DeployLib.write(s, IMD, address(b), address(ethMinter), vm.envOr("MANIFEST_PATH", string("app/public/deploy.robinhood.json")));
        } else {
            console.log("dry run: deploy.robinhood.json not written");
        }
    }
}
