// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeacon} from "../src/DrandBeacon.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {DeployLib, Config, System, DeployScript} from "../script/Deploy.s.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {MockIMD, MockBeacon} from "./Mocks.sol";

/// The real deploy library, the generated catalog and the seat snapshot.
contract DeployTest is Test {
    MockIMD imd;
    MockBeacon beacon;

    function setUp() public {
        vm.warp(1_791_300_000);
        imd = new MockIMD();
        beacon = new MockBeacon();
    }

    function _config(bytes32 root, uint256 delay) internal view returns (Config memory) {
        return Config(IERC20(address(imd)), IBeacon(address(beacon)), address(0xD), root, 0.05 ether, delay);
    }

    function test_deployWiresTheLedgerToTheMachine() public {
        System memory s = DeployLib.deploy(_config(0, 0), address(this));
        assertEq(s.parts.machine(), address(s.machine));
        assertEq(address(s.machine.inventory()), address(s.parts));
        assertEq(address(s.views.machine()), address(s.machine));
    }

    function test_catalogCoversEverySlot() public pure {
        uint256 total;
        for (uint8 tier; tier <= 4; ++tier) {
            for (uint8 t; t < Shapes.COUNT; ++t) {
                uint256 n = Catalog.slotSize(tier, t);
                if (Shapes.dropOdds(tier, t) == 0) {
                    assertEq(n, 0);
                    continue;
                }
                assertGt(n, 0);
                total += n;
                for (uint256 k; k < n; ++k) {
                    uint16 d = Catalog.partFor(tier, t, k);
                    assertEq(Catalog.tierOf(d), tier);
                    assertEq(Catalog.tmplOf(d), t);
                    for (uint256 j; j < k; ++j) assertTrue(Catalog.partFor(tier, t, j) != d, "each part once");
                }
            }
        }
        assertEq(total, Catalog.COUNT);
        assertEq(Catalog.slotSize(4, Shapes.CROSS), 1, "one Agent Core");
    }

    /// the art was drawn for the sockets the contract enforces (art/out/templates.json from art/parts.mjs)
    function test_artTemplatesMatchShapes() public view {
        string memory j = vm.readFile("art/out/templates.json");
        for (uint8 t; t < Shapes.COUNT; ++t) {
            string memory k = string.concat(".[", vm.toString(uint256(t)), "]");
            (uint8 n, int8[9] memory dx, int8[9] memory dy, uint8[9] memory mm) = Shapes.template(t);
            assertEq(vm.parseJsonUint(j, string.concat(k, ".n")), n, "cell count");
            uint256[] memory jx = vm.parseJsonUintArray(j, string.concat(k, ".dx"));
            uint256[] memory jy = vm.parseJsonUintArray(j, string.concat(k, ".dy"));
            uint256[] memory jm = vm.parseJsonUintArray(j, string.concat(k, ".m"));
            for (uint256 i; i < n; ++i) {
                assertEq(jx[i], uint256(int256(dx[i])));
                assertEq(jy[i], uint256(int256(dy[i])));
                assertEq(jm[i], mm[i], "sockets");
            }
        }
    }

    function test_realSnapshotProof() public {
        string memory j = vm.readFile("test/fixtures-seat.json");
        System memory s = DeployLib.deploy(_config(vm.parseJsonBytes32(j, ".root"), 0), address(this));
        address owner = vm.parseJsonAddress(j, ".owner");
        vm.prank(owner);
        uint256 id = s.machine.claimAgentCore(uint16(vm.parseJsonUint(j, ".seat")), vm.parseJsonBytes32Array(j, ".proof"));
        assertEq(s.parts.ownerOf(id), owner);
    }

    /// DP-01 (fixed): the deploy refuses a countdown past 30 days (a date or milliseconds), a zero price or a missing developer address
    function test_DP01_deployChecks() public {
        Config memory c = _config(0, block.timestamp);
        vm.expectRevert(bytes("DELAY: seconds, at most 30 days"));
        this.deployExt(c);
        c = _config(0, 0);
        c.basePrice = 0;
        vm.expectRevert(bytes("base price"));
        this.deployExt(c);
        c = _config(0, 0);
        c.dev = address(0);
        vm.expectRevert(bytes("dev address"));
        this.deployExt(c);
    }

    /// The swarm deploys launch.json: the script's values, in order, each constructor naming only earlier contracts
    function test_launchManifestMatchesTheDeployScript() public {
        DeployScript d = new DeployScript();
        string memory j = vm.readFile("launch.json");
        assertEq(vm.parseJsonString(j, ".kind"), "evm_contracts");
        string[4] memory names = ["DrandBeacon", "IdentityMachine", "MachineViews", "EthMinter"];
        for (uint256 i; i < 4; ++i) assertEq(vm.parseJsonString(j, string.concat(".contracts[", vm.toString(i), "].contract")), names[i]);
        assertFalse(vm.keyExistsJson(j, ".contracts[4]"));
        assertEq(abi.encode(vm.parseJsonStringArray(j, ".contracts[0].constructorArgs")), abi.encode(new string[](0)));
        string[] memory a = vm.parseJsonStringArray(j, ".contracts[1].constructorArgs");
        assertEq(a.length, 6);
        assertEq(vm.parseAddress(a[0]), d.IMD());
        assertEq(a[1], "$contract:DrandBeacon");
        assertEq(a[2], "$owner"); // the dev payout, named when the launch is paid for
        assertEq(vm.parseBytes32(a[3]), d.SEAT_ROOT());
        assertEq(vm.parseUint(a[4]), d.BASE_PRICE());
        assertEq(vm.parseUint(a[5]), d.COUNTDOWN());
        a = vm.parseJsonStringArray(j, ".contracts[2].constructorArgs");
        assertEq(a.length, 1);
        assertEq(a[0], "$contract:IdentityMachine");
        a = vm.parseJsonStringArray(j, ".contracts[3].constructorArgs");
        assertEq(a.length, 5);
        assertEq(a[0], "$contract:IdentityMachine");
        assertEq(vm.parseAddress(a[1]), d.POOL_MANAGER());
        assertEq(vm.parseAddress(a[2]), d.QUOTER());
        assertEq(vm.parseUint(a[3]), d.POOL_FEE());
        assertEq(vm.parseUint(a[4]), d.TICK_SPACING());
    }

    /// The countdown is a delay from deployment, so it holds however long the deployment takes to land
    function test_countdownStartsAtDeployment() public {
        vm.warp(1_800_000_000);
        IdentityMachine m = new IdentityMachine(IERC20(address(imd)), IBeacon(address(beacon)), address(0xD), 0, 0.05 ether, 48 hours);
        assertEq(m.start(), 1_800_000_000 + 48 hours);
        assertEq(Parts(address(m.inventory())).machine(), address(m));
        vm.expectRevert(IdentityMachine.BadDelay.selector);
        new IdentityMachine(IERC20(address(imd)), IBeacon(address(beacon)), address(0xD), 0, 0.05 ether, 30 days + 1);
    }

    function deployExt(Config memory c) external {
        DeployLib.deploy(c, address(this));
    }
}
