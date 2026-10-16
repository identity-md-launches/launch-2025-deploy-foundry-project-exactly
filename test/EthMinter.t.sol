// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine, IParts} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {IBeacon} from "../src/DrandBeacon.sol";
import {EthMinter, IEthPoolManager, IEthQuoter, EthPoolKey, EthSwapParams} from "../src/EthMinter.sol";
import {DevEthPool} from "../src/dev/DevEthPool.sol";
import {DevIMD} from "../src/dev/DevIMD.sol";
import {MockBeacon} from "./Mocks.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RefundWallet {
    EthMinter public minter;
    bool public reject;
    bool public blocked;
    bool public reentered;
    bool private tried;
    bytes4 public reason;
    constructor(EthMinter m, bool reject_) { minter = m; reject = reject_; }
    function buy(uint256 n, uint256 max) external payable { minter.mint{value: msg.value}(n, max, block.timestamp); }
    /// re-enter once with enough ETH for a real purchase, so only the reentrancy guard can stop it
    receive() external payable {
        require(!reject, "no refunds");
        if (tried) return;
        tried = true;
        try minter.mint{value: address(this).balance}(1, type(uint256).max, block.timestamp) { reentered = true; }
        catch (bytes memory e) { blocked = true; reason = bytes4(e); }
    }
}

/// A machine with its non-transferable inventory and native ETH checkout.
function bareMachine(Test t, IERC20 imd, IBeacon beacon) returns (IdentityMachine m, Parts parts) {
    t; // kept for callers' signature
    m = new IdentityMachine(imd, beacon, address(0xD), bytes32(0), 0.05 ether, 0);
    parts = Parts(address(m.inventory()));
}

contract EthMinterTest is Test {
    DevIMD imd;
    MockBeacon beacon;
    IdentityMachine machine;
    Parts parts;
    DevEthPool pool;
    EthMinter minter;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_791_000_000);
        imd = new DevIMD();
        beacon = new MockBeacon();
        (machine, parts) = bareMachine(this, imd, beacon);
        pool = new DevEthPool(imd);
        minter = new EthMinter(machine, IEthPoolManager(address(pool)), IEthQuoter(address(pool)), 10_000, 100);
        vm.deal(alice, 100 ether);
    }

    function testFuzz_atomicMintRefundAndOwnership(uint8 count, uint96 extra) public {
        uint256 n = bound(count, 1, 200);
        uint256 refund = bound(extra, 0, 10 ether);
        (uint256 total, uint256 cost) = minter.quote(n);
        uint256 before = alice.balance;
        vm.prank(alice);
        (uint256 first, uint256 paid) = minter.mint{value: cost + refund}(n, total, block.timestamp);
        assertEq(paid, cost);
        assertEq(before - alice.balance, cost, "only actual swap input spent");
        assertEq(address(minter).balance, 0);
        assertEq(imd.balanceOf(address(minter)), 0);
        assertEq(imd.allowance(address(minter), address(machine)), 0);
        assertEq(imd.balanceOf(alice), 0, "no user IMD needed");
        assertEq(imd.allowance(alice, address(machine)), 0, "no user approval");
        assertEq(machine.minted(), n);
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = first + i;
            (address owner, uint48 dr) = machine.pending(ids[i]);
            assertEq(owner, alice);
            beacon.set(uint64(dr), bytes32(uint256(123)));
        }
        machine.reveal(ids);
        assertEq(parts.balanceOf(alice), n, "the parts belong to the payer");
        assertEq(parts.balanceOf(address(minter)), 0);
    }

    function _pot() internal view returns (uint256 pot) {
        (,,,,,,,,,,, pot,,) = machine.rounds(machine.round());
    }

    function testFuzz_ethReferralUsesImdPriceAndRefundsUnusedEth(uint8 count, uint96 extra) public {
        uint256 n = bound(count, 1, 200);
        uint256 refund = bound(extra, 0, 10 ether);
        (uint256 total, uint256 cost) = minter.quote(n);
        uint256 before = alice.balance;
        vm.prank(alice);
        (uint256 first, uint256 paid) = minter.mintWithReferral{value: cost + refund}(n, total, block.timestamp, bob);
        assertEq(paid, cost);
        assertEq(before - alice.balance, cost);
        assertEq(address(minter).balance, 0);
        assertEq(imd.balanceOf(address(minter)), 0);
        assertEq(imd.allowance(address(minter), address(machine)), 0);
        assertEq(machine.referralBalance(bob), total * 300 / 10_000);
        (address owner,) = machine.pending(first);
        assertEq(owner, alice);
        vm.prank(bob);
        machine.claimReferral();
        assertEq(imd.balanceOf(bob), total * 300 / 10_000);
    }

    function test_ethSelfReferralAllowedAndHelperDoesNotRetainReward() public {
        (uint256 total, uint256 cost) = minter.quote(1);
        uint256 reward = total * 300 / 10_000;
        vm.prank(alice);
        minter.mintWithReferral{value: cost}(1, total, block.timestamp, alice);
        (total, cost) = minter.quote(1);
        vm.prank(alice);
        minter.mintWithReferral{value: cost}(1, total, block.timestamp, address(minter));
        assertEq(machine.referralBalance(alice), reward);
        assertEq(machine.referralBalance(address(minter)), 0);
    }

    function _deadline() internal view returns (uint256 d) {
        (, uint40 dl,,,,,,,,,,,,) = machine.rounds(machine.round());
        d = dl;
    }

    function test_insufficientEthRevertsEntireMint() public {
        (uint256 total, uint256 cost) = minter.quote(5);
        uint256 before = alice.balance;
        vm.expectRevert(EthMinter.NotEnoughEth.selector);
        vm.prank(alice);
        minter.mint{value: cost - 1}(5, total, block.timestamp);
        assertEq(machine.minted(), 0);
        assertEq(_pot(), 0);
        assertEq(alice.balance, before);
        assertEq(address(pool).balance, 0);
    }

    function test_priceLimitAndExpiry() public {
        (uint256 total, uint256 cost) = minter.quote(1);
        vm.expectRevert(EthMinter.TooExpensive.selector);
        vm.prank(alice);
        minter.mint{value: cost}(1, total - 1, block.timestamp);
        vm.expectRevert(EthMinter.QuoteExpired.selector);
        vm.prank(alice);
        minter.mint{value: cost}(1, total, block.timestamp - 1);
        assertEq(machine.minted(), 0);
    }

    function test_batchAndCallbackChecks() public {
        vm.expectRevert(IdentityMachine.BadBatch.selector);
        minter.quote(0);
        vm.expectRevert(IdentityMachine.BadBatch.selector);
        minter.mint(201, type(uint256).max, block.timestamp);
        vm.expectRevert(EthMinter.BadCallback.selector);
        minter.unlockCallback(abi.encode(1 ether, 1 ether));
        vm.expectRevert(EthMinter.BadCallback.selector);
        vm.prank(address(pool));
        minter.unlockCallback(abi.encode(1 ether, 1 ether));
    }

    function test_partialFillReverts() public {
        (uint256 total, uint256 cost) = minter.quote(1);
        int256 delta = (int256(-int128(int256(cost))) << 128) | int256(total - 1);
        vm.mockCall(address(pool), abi.encodeWithSelector(IEthPoolManager.swap.selector), abi.encode(delta));
        vm.expectRevert(EthMinter.PartialFill.selector);
        vm.prank(alice);
        minter.mint{value: cost}(1, total, block.timestamp);
        assertEq(machine.minted(), 0);
    }

    function test_refundRejectRevertsAndReentryIsBlocked() public {
        (uint256 total, uint256 cost) = minter.quote(1);
        RefundWallet rejecting = new RefundWallet(minter, true);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(EthMinter.RefundFailed.selector);
        rejecting.buy{value: cost + 1}(1, total);
        assertEq(machine.minted(), 0);
        assertEq(address(minter).balance, 0);
        RefundWallet reentering = new RefundWallet(minter, false);
        vm.deal(address(reentering), 1 ether); // funds a genuine second purchase from inside the refund
        reentering.buy{value: cost + 1}(1, total);
        assertTrue(reentering.blocked());
        assertFalse(reentering.reentered());
        assertEq(reentering.reason(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(machine.minted(), 1);
        (address owner,) = machine.pending(1);
        assertEq(owner, address(reentering));
    }

    function test_giftChargesOnlyPayer() public {
        imd.mint(alice, 1 ether);
        imd.mint(bob, 2 ether);
        uint256 total = machine.quote(2);
        vm.startPrank(alice);
        imd.approve(address(machine), total);
        machine.mintFor(bob, 2, total);
        vm.stopPrank();
        assertEq(imd.balanceOf(alice), 1 ether - total);
        assertEq(imd.balanceOf(bob), 2 ether);
        (address owner,) = machine.pending(1);
        assertEq(owner, bob);
        vm.expectRevert(IdentityMachine.BadRecipient.selector);
        machine.mintFor(address(0), 1, type(uint256).max);
    }

    function test_newRoundQuoteAndPayment() public {
        (uint256 total, uint256 cost) = minter.quote(10);
        vm.prank(alice);
        minter.mint{value: cost}(10, total, block.timestamp);
        vm.warp(_deadline());
        (total, cost) = minter.quote(1);
        assertEq(total, 0.05 ether);
        vm.prank(alice);
        minter.mint{value: cost}(1, total, block.timestamp);
        assertEq(machine.round(), 2);
        (,,, uint32 roundMinted,,,,,,,,,,) = machine.rounds(2);
        assertEq(roundMinted, 1);
    }
}

/// Run with --fork-url https://robinhood.drpc.org --fork-block-number 82662134.
contract EthMinterForkTest is Test {
    function test_liveExactOutputPool() public {
        vm.skip(block.chainid != 4663);
        IERC20 imd = IERC20(0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127);
        MockBeacon beacon = new MockBeacon();
        (IdentityMachine machine,) = bareMachine(this, imd, beacon);
        EthMinter minter = new EthMinter(machine,
            IEthPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951),
            IEthQuoter(0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94), 10_000, 100);
        address alice = makeAddr("eth buyer");
        vm.deal(alice, 1 ether);
        (uint256 total, uint256 cost) = minter.quote(5);
        uint256 burntBefore = imd.balanceOf(machine.DEAD());
        assertGt(cost, 0);
        vm.prank(alice);
        (uint256 first, uint256 spent) = minter.mint{value: cost * 102 / 100}(5, total, block.timestamp);
        assertEq(spent, cost, "quoter agrees with real swap");
        assertEq(alice.balance, 1 ether - cost);
        assertEq(address(minter).balance, 0);
        assertEq(imd.balanceOf(address(minter)), 0);
        assertEq(imd.allowance(address(minter), address(machine)), 0);
        assertEq(imd.balanceOf(alice), 0);
        assertEq(machine.minted(), 5);
        (address owner,) = machine.pending(first);
        assertEq(owner, alice);
        // All the original fee destinations remain fully accounted for.
        assertEq(imd.balanceOf(address(machine)) + imd.balanceOf(machine.DEAD()) - burntBefore, total);
    }
}
