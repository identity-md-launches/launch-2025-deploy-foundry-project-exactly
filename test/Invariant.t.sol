// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IdentityMachine} from "../src/IdentityMachine.sol";
import {MachineViews} from "../src/MachineViews.sol";
import {Parts} from "../src/Parts.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {Base, TestMachine} from "./Base.sol";
import {MockIMD, MockBeacon} from "./Mocks.sol";

/// Random play across many rounds: mints, real reveals (random drand values), placements, claims, the clock,
/// funding, sponsoring and the developer payout.
contract Handler is Test {
    TestMachine immutable m;
    MachineViews immutable views;
    Parts immutable parts;
    MockIMD immutable imd;
    MockBeacon immutable beacon;

    address[3] actors;
    uint256[] pendingIds;
    mapping(address => uint256[]) inv; // revealed, not placed
    mapping(address => uint256[]) placed;
    int32[] cx;
    int32[] cy;
    uint256 frontierRound;

    uint256 public paidIn; // IMD sent to the machine by actors
    uint256 public claimed;
    uint256 public referralClaimed;
    uint256 public devPaid;
    uint256 public burnExpected;
    uint256 public revealedUnplaced;
    uint256 public placedCount;
    uint256 public surplus;
    mapping(bytes4 => uint256) public successes;

    constructor(IdentityMachine m_, MachineViews v, Parts p, MockIMD imd_, MockBeacon b, address[3] memory a) {
        (m, views, parts, imd, beacon, actors) = (TestMachine(address(m_)), v, p, imd_, b, a);
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    function mint(uint256 who, uint256 n) external {
        address a = _actor(who);
        _mintTo(a, a, n);
        ++successes[this.mint.selector];
    }

    function giftMint(uint256 payer, uint256 recipient, uint256 n) external {
        _mintTo(_actor(payer), _actor(recipient), n);
        ++successes[this.giftMint.selector];
    }

    function referredMint(uint256 payer, uint256 recipient, uint256 referrer, uint256 n) external {
        n = bound(n, 1, 50);
        uint256 total = m.quote(n);
        vm.prank(_actor(payer));
        (uint256 first,) = m.mintForWithReferral(_actor(recipient), n, total, _actor(referrer));
        paidIn += total;
        burnExpected += (total * 200) / 10_000;
        for (uint256 i; i < n; ++i) pendingIds.push(first + i);
        ++successes[this.referredMint.selector];
    }

    function claimReferral(uint256 who) public {
        address a = _actor(who);
        vm.prank(a);
        referralClaimed += m.claimReferral();
        ++successes[this.claimReferral.selector];
    }

    function _mintTo(address payer, address recipient, uint256 n) internal {
        n = bound(n, 1, 50);
        uint256 total = m.quote(n);
        vm.prank(payer);
        (uint256 first,) = m.mintFor(recipient, n, total);
        paidIn += total;
        burnExpected += (total * 200) / 10_000;
        for (uint256 i; i < n; ++i) pendingIds.push(first + i);
    }

    /// reveal up to ten pending mints with random drand values
    function reveal(uint256 seed) external {
        for (uint256 j; j < 10 && pendingIds.length > 0; ++j) {
            uint256 k = uint256(keccak256(abi.encode(seed, j))) % pendingIds.length;
            uint256 id = pendingIds[k];
            (address owner, uint48 dr) = m.pending(id);
            if (beacon.randomness(uint64(dr)) == 0) beacon.set(uint64(dr), keccak256(abi.encode(seed, dr)));
            m.reveal(_one(id));
            pendingIds[k] = pendingIds[pendingIds.length - 1];
            pendingIds.pop();
            inv[owner].push(id);
            ++revealedUnplaced;
            ++successes[this.reveal.selector];
        }
    }



    function transfer(uint256 who, uint256 recipient, uint256 seed) external {
        address from = _actor(who);
        address to = _actor(recipient);
        uint256[] storage mine = inv[from];
        if (mine.length == 0) return;
        uint256 id = mine[seed % mine.length];
        vm.prank(from);
        (bool ok,) = address(parts).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, id));
        assertFalse(ok);
        assertEq(parts.ownerOf(id), from);
        ++successes[this.transfer.selector];
    }

    function claimCore(uint256 who) external {
        uint256 k = who % 2;
        uint16 seat = k == 0 ? 1723 : 7;
        if (m.seatClaimed(seat)) return;
        address a = actors[k];
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = k == 0
            ? keccak256(bytes.concat(keccak256(abi.encode(uint16(7), actors[1]))))
            : keccak256(bytes.concat(keccak256(abi.encode(uint16(1723), actors[0]))));
        vm.prank(a);
        uint256 id = m.claimAgentCore(seat, proof);
        inv[a].push(id);
        ++revealedUnplaced;
        ++successes[this.claimCore.selector];
    }

    /// try to plug in up to five of an actor's parts
    function place(uint256 who, uint256 seed) external {
        address a = _actor(who);
        uint256[] storage mine = inv[a];
        for (uint256 j; j < 5 && mine.length > 0; ++j) {
            if (block.timestamp >= _deadline()) return; // the round is over until someone ends it
            uint256 r = m.round();
            if (frontierRound != r) _resetFrontier(r);
            uint256 s = uint256(keccak256(abi.encode(seed, j)));
            uint256 k = s % mine.length;
            uint256 id = mine[k];
            if (!_grow(a, id, r, s)) continue;
            mine[k] = mine[mine.length - 1];
            mine.pop();
            placed[a].push(id);
            --revealedUnplaced;
            ++placedCount;
            ++successes[this.place.selector];
        }
    }

    function claim(uint256 who) external {
        address a = _actor(who);
        if (placed[a].length == 0) return;
        uint256 before = imd.balanceOf(a);
        vm.prank(a);
        m.claim(placed[a]);
        claimed += imd.balanceOf(a) - before;
        ++successes[this.claim.selector];
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 12 hours));
        ++successes[this.warp.selector];
    }

    function endRound() external {
        if (block.timestamp < _deadline()) return;
        m.endRound();
        ++successes[this.endRound.selector];
    }

    function fund(uint256 who, uint256 amount, uint256 kind) external {
        address a = _actor(who);
        amount = bound(amount, 1, 10 ether);
        vm.startPrank(a);
        if (kind % 4 == 0) {
            m.fundReserve(amount);
        } else if (kind % 4 == 1) {
            m.fundPot(amount);
        } else if (kind % 4 == 2) {
            if (block.timestamp >= _deadline() || views.roundInfo(m.round()).placed == 0) {
                vm.stopPrank();
                return;
            }
            m.sponsor(amount);
        } else {
            imd.transfer(address(m), amount);
            surplus += amount;
        }
        vm.stopPrank();
        paidIn += amount;
        ++successes[this.fund.selector];
    }

    function payDev() external {
        devPaid += m.devBalance();
        m.payDev();
        ++successes[this.payDev.selector];
    }

    /// End-of-campaign withdrawals; pending plug-pay remains held until installation.
    function settle() external {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 before = imd.balanceOf(a);
            vm.prank(a);
            m.claim(placed[a]);
            claimed += imd.balanceOf(a) - before;
            claimReferral(i);
        }

    }

    // ------------------------------------------------------------ bookkeeping for the invariants

    /// everything the machine owes, in IMD
    function owed() external view returns (uint256 total) {
        total = m.reserve() + m.devBalance();
        for (uint256 i; i < actors.length; ++i) total += m.referralBalance(actors[i]);
        (,,,,,,,,,,, uint256 pot,,) = m.rounds(m.round());
        total += pot;
        uint256 next = m.nextId();
        for (uint256 id = 1; id < next; ++id) {
            (,,, uint32 machine,,,, uint112 plug) = m.parts(id);
            if (machine == 0) total += plug;
            else total += m.earned(id);
        }
    }

    function itemsHeld() external view returns (uint256 n) {
        for (uint256 i; i < 3; ++i) n += parts.balanceOf(actors[i]);
    }

    // ------------------------------------------------------------ helpers

    function _deadline() internal view returns (uint256 d) {
        (, uint40 dl,,,,,,,,,,,,) = m.rounds(m.round());
        d = dl;
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _resetFrontier(uint256 r) internal {
        delete cx;
        delete cy;
        frontierRound = r;
        for (int32 k = -1; k <= 1; ++k) {
            _cand(k, -2);
            _cand(2, k);
            _cand(k, 2);
            _cand(-2, k);
        }
    }

    function _cand(int32 x, int32 y) internal {
        cx.push(x);
        cy.push(y);
    }

    function _grow(address who, uint256 id, uint256 r, uint256 seed) internal returns (bool) {
        for (uint256 t; t < 12 && cx.length > 0; ++t) {
            uint256 k = uint256(keccak256(abi.encode(seed, t))) % cx.length;
            (int32 x, int32 y) = (cx[k], cy[k]);
            (bool occ,,) = m.cellAt(r, x, y);
            if (occ) {
                cx[k] = cx[cx.length - 1];
                cy[k] = cy[cy.length - 1];
                cx.pop();
                cy.pop();
                continue;
            }
            if (this.growAtExt(who, id, r, x, y)) return true;
        }
        return false;
    }

    function growAtExt(address who, uint256 id, uint256 r, int32 x, int32 y) external returns (bool) {
        require(msg.sender == address(this));
        (uint16 design,,,,,,,) = m.parts(id);
        for (uint8 rot; rot < 4; ++rot) {
            (uint8 n, int32[9] memory fx, int32[9] memory fy,) = Shapes.footprint(Catalog.tmplOf(design), rot, 0, 0);
            for (uint256 i; i < n; ++i) {
                (int32 ax, int32 ay) = (x - fx[i], y - fy[i]);
                try m.check(design, rot, ax, ay) {
                    if (!this.tryBuildExt(who, r, id, rot, ax, ay)) continue;
                    for (uint256 j; j < n; ++j) {
                        _cand(ax + fx[j], ay + fy[j] - 1);
                        _cand(ax + fx[j] + 1, ay + fy[j]);
                        _cand(ax + fx[j], ay + fy[j] + 1);
                        _cand(ax + fx[j] - 1, ay + fy[j]);
                    }
                    return true;
                } catch {}
            }
        }
        return false;
    }

    function tryBuildExt(address who, uint256 r, uint256 id, uint8 rot, int32 x, int32 y) external returns (bool) {
        require(msg.sender == address(this));
        IdentityMachine.Spot[] memory spots = new IdentityMachine.Spot[](1);
        spots[0] = IdentityMachine.Spot(id, rot, x, y);
        vm.prank(who);
        try m.build(r, new IdentityMachine.Proof[](0), new uint256[](0), spots) { return true; } catch { return false; }
    }
}

contract InvariantTest is Base {
    Handler h;

    function setUp() public override {
        super.setUp();
        h = new Handler(m, views, parts, imd, beacon, [alice, bob, carol]);
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = Handler.mint.selector;
        selectors[1] = Handler.giftMint.selector;
        selectors[2] = Handler.reveal.selector;
        selectors[3] = Handler.transfer.selector;
        selectors[4] = Handler.claimCore.selector;
        selectors[5] = Handler.place.selector;
        selectors[6] = Handler.claim.selector;
        selectors[7] = Handler.warp.selector;
        selectors[8] = Handler.endRound.selector;
        selectors[9] = Handler.fund.selector;
        selectors[10] = Handler.payDev.selector;
        selectors[11] = Handler.referredMint.selector;
        selectors[12] = Handler.claimReferral.selector;
        targetSelector(FuzzSelector(address(h), selectors));
    }

    /// progress across a run (FOUNDRY_INVARIANT_RUNS=4 forge test --match-contract InvariantTest -vv shows it)
    function afterInvariant() public {
        h.settle();
        invariant_solventAndExact();
        invariant_conservation();
        emit log_named_uint("rounds", m.round());
        emit log_named_uint("parts placed", h.placedCount());
        emit log_named_uint("claimed (milli-IMD)", h.claimed() / 1e15);
        emit log_named_uint("gift mints executed", h.successes(Handler.giftMint.selector));
        emit log_named_uint("transfers rejected", h.successes(Handler.transfer.selector));
        emit log_named_uint("cores claimed", h.successes(Handler.claimCore.selector));
    }



    function test_handlerExercisesGiftTransferCoreAndRetainsOverduePendingLiability() public {
        h.giftMint(0, 1, 2);
        h.reveal(123);
        h.transfer(1, 2, 0);
        h.claimCore(0);
        vm.warp(_now() + 3);
        h.mint(0, 1);
        (address owner, uint48 dr) = m.pending(4);
        assertEq(owner, alice);
        vm.warp(beacon.timeOf(dr) + 30 days);
        h.settle();
        assertGt(_plugOf(4), 0);
        assertEq(h.successes(Handler.giftMint.selector), 1);
        assertEq(h.successes(Handler.transfer.selector), 1);
        assertEq(h.successes(Handler.claimCore.selector), 1);
        invariant_solventAndExact();
        invariant_conservation();
        invariant_roundsAndSupply();
    }

    /// the machine holds exactly what it owes, give or take rounding dust (floors in the shared accumulator)
    function invariant_solventAndExact() public view {
        uint256 bal = imd.balanceOf(address(m));
        uint256 owed = h.owed();
        assertGe(bal, owed, "solvent");
        assertGe(bal, owed + h.surplus(), "donations are separately accounted for");
        assertLe(bal - owed - h.surplus(), 1e6, "no IMD unaccounted for beyond dust");
    }

    /// every IMD an actor sent in is in the machine, burned, claimed or paid to the developer
    function invariant_conservation() public view {
        assertEq(
            h.paidIn(),
            imd.balanceOf(address(m)) + imd.balanceOf(DEAD) + h.claimed() + h.referralClaimed() + h.devPaid()
        );
    }

    function invariant_burnIsTwoPercent() public view {
        assertEq(imd.balanceOf(DEAD), h.burnExpected());
    }

    /// the running machine's open-socket counter is exact, and every touching edge matches
    function invariant_openSocketsAndWiring() public view {
        uint256 r = m.round();
        assertEq(views.roundInfo(r).open, this.bruteOpenExt(r));
        assertGt(views.roundInfo(r).open, 0);
        assertGt(m.previewGrowthExit(r, new IdentityMachine.Spot[](0), new IdentityMachine.Proof[](0)).direction, 0);
    }

    /// every finished round paid its places at most 70% of its pot; part supply is the revealed, unplaced parts
    function invariant_roundsAndSupply() public view {
        uint256 r = m.round();
        for (uint256 i = 1; i < r; ++i) {
            MachineViews.RoundInfo memory info = views.roundInfo(i);
            assertLe(info.prize, (info.pot * 7000) / 10_000);
            assertGt(info.ended, 0);
            assertEq(info.ended, info.deadline);
            // the places went to the last ten parts placed, the most recent first, and to no earlier part
            uint256 filled = info.placed < 10 ? info.placed : 10;
            for (uint256 k = 1; k <= filled; ++k) {
                (,, uint8 place,,,,,) = m.parts(m.order(i, info.placed - k + 1));
                assertEq(place, k, "places follow placement order");
            }
            if (info.placed > 10) {
                (,, uint8 place,,,,,) = m.parts(m.order(i, info.placed - 10));
                assertEq(place, 0, "the eleventh-last part wins nothing");
            }
        }
        assertEq(parts.totalSupply(), h.revealedUnplaced());
        assertEq(h.itemsHeld(), h.revealedUnplaced());
    }
}
