// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine} from "../../src/IdentityMachine.sol";
import {bareMachine} from "../EthMinter.t.sol";
import {DrandBeacon, IBeacon} from "../../src/DrandBeacon.sol";
import {Shapes} from "../../src/Shapes.sol";
import {Catalog} from "../../src/art/Catalog.sol";
import {MockIMD} from "../Mocks.sol";

/// drand evmnet verification, its round clock, and how mints use it.
/// Signatures fetched from https://api.drand.sh/v2/beacons/evmnet on 2026-10-07; chain info in
/// test/audit/vectors/drand-info.json (period 3 s, genesis 1727521075, scheme bls-bn254-unchained-on-g1).
contract BeaconTest is Test {
    DrandBeacon b;

    uint64[6] rounds = [uint64(1), 2, 1_000_000, 21_238_365, 21_238_366, 21_280_723];
    bytes[6] sigs;

    function setUp() public {
        b = new DrandBeacon();
        sigs[0] = hex"11f812d738a36b2210dc88c2d635ad8039588205f42445d6de09e6530165c3462a23aca348c84badcf8df5321ac24577b7963d5b0d780bc4626baedb45cde373";
        sigs[1] = hex"1dbfe644485f31e2a7978fb551b50933b0001e64397fd2b7dc4022e8e2fcdbc325798cea5506deec489c8db3b4697f6b1bb6be8934b95bd9c0db88923487d9ad";
        sigs[2] = hex"139a803860ff6d842b822b8b37eaeccc4e278dd44440535a976530a1a503e85e11d84b824f18e608a85e627e6b1b08322060cbcf7eca1ea78489252907e8473a";
        sigs[3] = hex"2e6586e88e308d252d93f2775068735df1557cfcd5ab71661abacdddc864147c0fe3c18439c99ee9fb8515d2a908ca08b6e38669272c5699614e517c4ae895d1";
        sigs[4] = hex"0b28c4ae3518c6d910ee71d808920caa1af6d17e1415e6971c0ded1d821284bb054f394bc5bb6f27fa584830d060c7e45a40a4517bbe12b7ec0d75ce90a68746";
        sigs[5] = hex"2d0235ef648494c7548cadb76e0e06eec8729dec60c930a47c1e4ce3535b3423139a77fef7d29839366c866fa002647bb6adfe8f173930c0192c3e07e88c4524";
    }

    /// six live rounds verify, from genesis to now; each signature verifies only for its own round
    function test_liveRoundsVerifyAndDoNotCrossOver() public {
        for (uint256 i; i < 6; ++i) {
            uint256 g = gasleft();
            assertEq(b.prove(rounds[i], sigs[i]), keccak256(sigs[i]));
            if (i == 5) emit log_named_uint("prove gas", g - gasleft());
        }
        for (uint256 i; i < 6; ++i) {
            uint64 other = rounds[(i + 1) % 6];
            DrandBeacon fresh = new DrandBeacon();
            vm.expectRevert(DrandBeacon.InvalidSignature.selector);
            fresh.prove(other, sigs[i]);
        }
    }

    /// the contract's key is drand's published evmnet key (G2, drand serialises x.c1 x.c0 y.c1 y.c0)
    function test_publicKeyIsDrandsEvmnetKey() public view {
        string memory info = vm.readFile("test/audit/vectors/drand-info.json");
        bytes memory pk = vm.parseJsonBytes(info, ".public_key");
        assertEq(pk.length, 128);
        (uint256 a, uint256 c, uint256 d, uint256 e) = abi.decode(pk, (uint256, uint256, uint256, uint256));
        (uint256[2] memory x, uint256[2] memory y) = (b.publicKey().x, b.publicKey().y);
        assertEq(x[1], a);
        assertEq(x[0], c);
        assertEq(y[1], d);
        assertEq(y[0], e);
        assertEq(vm.parseJsonUint(info, ".period"), b.PERIOD());
        assertEq(vm.parseJsonUint(info, ".genesis_time"), b.GENESIS());
    }

    /// roundAt(t) is the first round published at or after t: round r is published at GENESIS + (r - 1) x PERIOD
    function testFuzz_roundAtIsFirstRoundAtOrAfter(uint32 dt) public view {
        uint256 t = b.GENESIS() + 1 + dt;
        uint256 r = b.roundAt(t);
        uint256 pub = b.GENESIS() + (r - 1) * 3;
        assertGe(pub, t);
        assertLt(pub - 3, t);
    }

    /// a mint's round is published 9 to 11 s after the mint's block time (DRAND_MARGIN = 3 rounds)
    function testFuzz_mintRoundIsInTheFuture(uint32 dt) public view {
        uint256 t = b.GENESIS() + 1 + dt;
        uint256 dr = b.roundAt(t) + 3;
        uint256 pub = b.timeOf(uint64(dr));
        assertEq(pub, b.GENESIS() + (dr - 1) * 3);
        assertGe(pub, t + 9);
        assertLe(pub, t + 11);
    }

    /// IM-05 (fixed in v6): with a 3-round margin, a sequencer clock lagging real time by 6 s (the v5 PoC) or up to
    /// 8 s still gives every mint a drand round that isn't public yet, so a contract can't mint, reveal and revert.
    function test_IM05_marginCoversALaggingSequencer() public {
        // the chain's clock reads 6 s before round 21238365 was published (in real time that round is public)
        vm.warp(b.timeOf(21_238_365) - 6);
        MockIMD imd = new MockIMD();
        (IdentityMachine m,) = bareMachine(this, imd, b);
        imd.mint(address(this), 1 ether);
        imd.approve(address(m), 1 ether);
        (uint256 id,) = m.mint(1, 1 ether);
        (, uint48 dr) = m.pending(id);
        assertGe(b.timeOf(uint64(dr)), vm.getBlockTimestamp() + 9, "published at least 9 s after the block time");
        assertGt(dr, 21_238_365);
        vm.expectRevert(IdentityMachine.NotReady.selector);
        m.reveal(_one(id));
    }

    /// The accepted limit (2026-10-15): a clock lagging 9 s or more lets a mint select a round already public in
    /// real time. Measured lag on Robinhood Chain was about 1.5 s.
    function test_IM05_nineSecondLagIsTheLimit() public {
        vm.warp(b.timeOf(21_238_365) - 9); // in real time, round 21238365 is public
        MockIMD imd = new MockIMD();
        (IdentityMachine m,) = bareMachine(this, imd, b);
        imd.mint(address(this), 1 ether);
        imd.approve(address(m), 1 ether);
        (uint256 id,) = m.mint(1, 1 ether);
        (, uint48 dr) = m.pending(id);
        assertEq(dr, 21_238_365);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    /// an invalid proof burns all the gas given to the pairing precompile (the library calls it with gas());
    /// harmless to the protocol, costly to whoever submits it (e.g. a client with a bad signature)
    function test_invalidProofBurnsForwardedGas() public {
        bytes memory bad = abi.encode(uint256(1), uint256(3)); // (1, 3) is not on y^2 = x^3 + 3
        uint256 g = gasleft();
        try b.prove{gas: 5_000_000}(7, bad) {
            fail();
        } catch {}
        uint256 used = g - gasleft();
        emit log_named_uint("gas used by a failing proof (5M forwarded)", used);
        assertGt(used, 4_500_000);
    }
}
