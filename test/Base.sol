// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityMachine, IParts} from "../src/IdentityMachine.sol";
import {Parts} from "../src/Parts.sol";
import {MachineViews} from "../src/MachineViews.sol";
import {IBeacon} from "../src/DrandBeacon.sol";
import {Shapes} from "../src/Shapes.sol";
import {Catalog} from "../src/art/Catalog.sol";
import {MockIMD, MockBeacon} from "./Mocks.sol";

/// catalog part ids (art/parts.mjs)
library G {
    uint16 constant PATCH = 0; // common straight E|W
    uint16 constant BEND = 1; // common corner E|S
    uint16 constant TEE = 2; // common tee E|W|S
    uint16 constant CROSS = 3; // common cross
    uint16 constant LONG = 4; // common long 2x1
    uint16 constant CAP = 5; // common cap S
    uint16 constant REEL = 6; // uncommon cross
    uint16 constant RADAR = 11; // rare hub 2x2
    uint16 constant CONSOLE = 15; // legendary 2x2, six sockets
    uint16 constant REACTOR = 16; // legendary 3x3, eight sockets
    uint16 constant AGENT_CORE = 17;
}

/// The machine with a test-only way to hand out a revealed part of any design.
contract TestMachine is IdentityMachine {
    constructor(
        IERC20 imd_,
        IBeacon beacon_,
        address dev_,
        bytes32 root_,
        uint256 base_,
        uint256 start_
    ) IdentityMachine(imd_, beacon_, dev_, root_, base_, start_) {}

    // TEST ONLY: older unit helpers derive a final witness, then execute the real guarded build.
    // The production ABI has only the five-argument build; security tests supply explicit hostile witnesses.
    function build(uint256 r, Proof[] calldata proofs, uint256[] calldata ids, Spot[] calldata spots) external {
        (bool ok, bytes memory result) = address(this).delegatecall(abi.encodeWithSelector(
            IdentityMachine.build.selector, r, proofs, ids, spots, previewGrowthExit(r, spots, proofs)));
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    struct Preview {
        int32 minX;
        int32 minY;
        int32 maxX;
        int32 maxY;
        int32[] xs;
        int32[] ys;
        uint8[] masks;
        uint256 n;
    }

    function previewGrowthExit(uint256 r, Spot[] calldata spots, Proof[] calldata proofs) public view returns (GrowthExit memory) {
        Round storage R = rounds[r];
        Preview memory p = Preview(R.minX, R.minY, R.maxX, R.maxY,
            new int32[](spots.length * 9), new int32[](spots.length * 9), new uint8[](spots.length * 9), 0);
        for (uint256 i; i < spots.length; ++i) {
            Spot calldata s = spots[i];
            if (s.rot > 3) continue; // preserve the production error for deliberately invalid input
            (uint8 n, int32[9] memory xs, int32[9] memory ys, uint8[9] memory masks) =
                Shapes.footprint(Catalog.tmplOf(_previewDesign(s.id, proofs)), s.rot, s.x, s.y);
            for (uint256 j; j < n; ++j) {
                if (xs[j] < -BOUND || xs[j] > BOUND || ys[j] < -BOUND || ys[j] > BOUND) return GrowthExit(0, 0, 0);
                p.xs[p.n] = xs[j]; p.ys[p.n] = ys[j]; p.masks[p.n++] = masks[j];
                if (xs[j] < p.minX) p.minX = xs[j];
                if (xs[j] > p.maxX) p.maxX = xs[j];
                if (ys[j] < p.minY) p.minY = ys[j];
                if (ys[j] > p.maxY) p.maxY = ys[j];
            }
        }
        for (uint256 i; i < p.n; ++i) {
            GrowthExit memory exit = _previewAt(r, p, p.xs[i], p.ys[i]);
            if (exit.direction != 0) return exit;
        }
        // Existing sockets can survive on an unchanged edge of the original bounding box.
        for (int32 x = R.minX; x <= R.maxX; ++x) {
            GrowthExit memory exit = _previewAt(r, p, x, R.minY);
            if (exit.direction != 0) return exit;
            exit = _previewAt(r, p, x, R.maxY);
            if (exit.direction != 0) return exit;
        }
        for (int32 y = R.minY; y <= R.maxY; ++y) {
            GrowthExit memory exit = _previewAt(r, p, R.minX, y);
            if (exit.direction != 0) return exit;
            exit = _previewAt(r, p, R.maxX, y);
            if (exit.direction != 0) return exit;
        }
        return GrowthExit(0, 0, 0);
    }

    function _previewDesign(uint256 id, Proof[] calldata proofs) private view returns (uint16) {
        Pending memory pm = pending[id];
        if (pm.owner == address(0)) return parts[id].design;
        bytes32 seed = beacon.randomness(pm.drandRound);
        for (uint256 j; seed == 0 && j < proofs.length; ++j) {
            if (proofs[j].drandRound == pm.drandRound) seed = keccak256(proofs[j].sig); // MockBeacon
        }
        uint256 roll = uint256(keccak256(abi.encode(seed, id)));
        uint8 tier = rollTier(roll);
        return Catalog.partFor(tier, Shapes.rollDrop(tier, roll >> 16), roll >> 32);
    }

    function _previewAt(uint256 r, Preview memory p, int32 x, int32 y) private view returns (GrowthExit memory) {
        uint8 mask = uint8(_cell(r, x, y));
        for (uint256 i; i < p.n; ++i) if (p.xs[i] == x && p.ys[i] == y) mask = p.masks[i];
        if (y == p.minY && y > -BOUND && mask & Shapes.N != 0) return GrowthExit(x, y, Shapes.N);
        if (x == p.maxX && x < BOUND && mask & Shapes.E != 0) return GrowthExit(x, y, Shapes.E);
        if (y == p.maxY && y < BOUND && mask & Shapes.S != 0) return GrowthExit(x, y, Shapes.S);
        if (x == p.minX && x > -BOUND && mask & Shapes.W != 0) return GrowthExit(x, y, Shapes.W);
        return GrowthExit(0, 0, 0);
    }

    /// a revealed part `d` for `to`, carrying `plug` IMD of plug-pay (paid in by the caller)
    function grant(address to, uint16 d, uint256 plug) external returns (uint256 id) {
        if (plug > 0) imd.transferFrom(msg.sender, address(this), plug);
        id = nextId++;
        parts[id].design = d;
        parts[id].plug = uint112(plug);
        inventory.mint(to, id);
    }
}

abstract contract Base is Test {
    TestMachine m;
    Parts parts;
    MachineViews views;
    MockIMD imd;
    MockBeacon beacon;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address devAddr = makeAddr("dev");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant BASE = 0.10 ether;
    uint256 constant T0 = 1_791_300_000; // read block time via vm.getBlockTimestamp(): via-ir caches block.timestamp
    bytes32 leafAlice;
    bytes32 leafBob;
    bytes32 root;

    IdentityMachine.Proof[] noProofs;
    uint256[] noIds;

    function setUp() public virtual {
        vm.warp(T0);
        imd = new MockIMD();
        beacon = new MockBeacon();
        leafAlice = keccak256(bytes.concat(keccak256(abi.encode(uint16(1723), alice))));
        leafBob = keccak256(bytes.concat(keccak256(abi.encode(uint16(7), bob))));
        root = leafAlice < leafBob ? keccak256(abi.encodePacked(leafAlice, leafBob)) : keccak256(abi.encodePacked(leafBob, leafAlice));
        _deploy();
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            imd.mint(who[i], 1e30);
            vm.prank(who[i]);
            imd.approve(address(m), type(uint256).max);
        }
        imd.mint(address(this), 1e30);
        imd.approve(address(m), type(uint256).max);
    }

    function _deploy() internal {
        _deployAt(0);
    }

    function _deployAt(uint256 delay) internal {
        m = new TestMachine(imd, beacon, devAddr, root, BASE, delay);
        parts = Parts(address(m.inventory()));
        views = new MachineViews(m);
    }

    // ------------------------------------------------------------ parts

    function _grant(address who, uint16 d) internal returns (uint256) {
        return m.grant(who, d, 0);
    }

    function _grantPlug(address who, uint16 d, uint256 plug) internal returns (uint256) {
        return m.grant(who, d, plug);
    }

    function _design(uint256 id) internal view returns (uint16 d) {
        (d,,,,,,,) = m.parts(id);
    }

    function _machineOf(uint256 id) internal view returns (uint256 r) {
        (,,, uint32 mm,,,,) = m.parts(id);
        r = mm;
    }

    function _placeOf(uint256 id) internal view returns (uint8 p) {
        (,, p,,,,,) = m.parts(id);
    }

    function _plugOf(uint256 id) internal view returns (uint256 p) {
        (,,,,,,, uint112 pl) = m.parts(id);
        p = pl;
    }

    // ------------------------------------------------------------ building

    function _spots1(uint256 id, uint8 rot, int32 x, int32 y) internal pure returns (IdentityMachine.Spot[] memory s) {
        s = new IdentityMachine.Spot[](1);
        s[0] = IdentityMachine.Spot(id, rot, x, y);
    }

    /// the running round, read from storage (slot 0) so expectRevert applies to the build itself
    function _r() internal view returns (uint256) {
        return uint256(vm.load(address(m), 0));
    }

    function _place(address who, uint256 id, uint8 rot, int32 x, int32 y) internal {
        uint256 r = _r();
        vm.prank(who);
        m.build(r, noProofs, noIds, _spots1(id, rot, x, y));
    }

    /// the twelve cap spots around the 3×3 core: (x, y, rot)
    function _capSpot(uint256 i) internal pure returns (int32 x, int32 y, uint8 rot) {
        int32 k = int32(int256(i % 3)) - 1;
        if (i < 3) return (k, -2, 0); // above, socket facing S
        if (i < 6) return (2, k, 1); // right, facing W
        if (i < 9) return (k, 2, 2); // below, facing N
        return (-2, k, 3); // left, facing E
    }

    /// cap the core's sockets i = from .. to - 1 with fresh caps of `who`
    function _caps(address who, uint256 from, uint256 to) internal returns (uint256[] memory ids) {
        ids = new uint256[](to - from);
        for (uint256 i = from; i < to; ++i) {
            ids[i - from] = _grant(who, G.CAP);
            (int32 x, int32 y, uint8 rot) = _capSpot(i);
            _place(who, ids[i - from], rot, x, y);
        }
    }

    /// Populate twelve prize places without sealing; finish only at clock expiry.
    function _finish(address who) internal returns (uint256[] memory ids) {
        ids = _line(who, 12);
        vm.warp(_round().deadline);
        m.endRound();
    }

    function _line(address who, uint256 n) internal returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _grant(who, G.PATCH);
            _place(who, ids[i], 0, int32(int256(i + 2)), 0);
        }
    }

    /// a spot where `design` fits the running machine, searching outward from the core
    function _findSpot(uint16 design) internal view returns (bool ok, uint8 rot, int32 x, int32 y) {
        for (int32 d = 2; d <= 12; ++d) {
            for (y = -d; y <= d; ++y) {
                for (x = -d; x <= d; ++x) {
                    if (x != -d && x != d && y != -d && y != d) continue;
                    for (rot = 0; rot < 4; ++rot) {
                        try m.check(design, rot, x, y) {
                            return (true, rot, x, y);
                        } catch {}
                    }
                }
            }
        }
    }

    function _placeAnywhere(address who, uint256 id) internal {
        (bool ok, uint8 rot, int32 x, int32 y) = _findSpot(_design(id));
        require(ok, "no spot");
        _place(who, id, rot, x, y);
    }

    // ------------------------------------------------------------ growing a machine at random

    int32[] internal candX;
    int32[] internal candY;

    /// empty cells next to the running machine's core: where the first parts can go
    function _resetFrontier() internal {
        delete candX;
        delete candY;
        for (int32 k = -1; k <= 1; ++k) {
            _cand(k, -2);
            _cand(2, k);
            _cand(k, 2);
            _cand(-2, k);
        }
    }

    function _cand(int32 x, int32 y) internal {
        candX.push(x);
        candY.push(y);
    }

    /// a catalog part as a mint would drop it
    function _drop(uint256 seed) internal view returns (uint16) {
        uint256 x = uint256(keccak256(abi.encode("drop", seed)));
        uint8 tier = m.rollTier(x);
        return Catalog.partFor(tier, Shapes.rollDrop(tier, x >> 16), x >> 32);
    }

    /// place part `id` (owned by `who`) somewhere it fits next to the frontier; false if no try fits
    function _grow(address who, uint256 id, uint256 seed, uint256 tries) internal returns (bool) {
        uint256 r = _r();
        for (uint256 t; t < tries && candX.length > 0; ++t) {
            uint256 k = uint256(keccak256(abi.encode(seed, t))) % candX.length;
            (int32 x, int32 y) = (candX[k], candY[k]);
            (bool occ,,) = m.cellAt(r, x, y);
            if (occ) {
                candX[k] = candX[candX.length - 1];
                candY[k] = candY[candY.length - 1];
                candX.pop();
                candY.pop();
                continue;
            }
            if (this.growAtExt(who, id, x, y)) return true;
        }
        return false;
    }

    // Separate test frame keeps the via-IR search helper small; production never scans the board.
    function growAtExt(address who, uint256 id, int32 x, int32 y) external returns (bool) {
        require(msg.sender == address(this));
        uint8 tmpl = Catalog.tmplOf(_design(id));
        uint256 r = _r();
        for (uint8 rot; rot < 4; ++rot) {
            (uint8 n, int32[9] memory cx, int32[9] memory cy,) = Shapes.footprint(tmpl, rot, 0, 0);
            for (uint256 i; i < n; ++i) {
                (int32 ax, int32 ay) = (x - cx[i], y - cy[i]);
                try m.check(_design(id), rot, ax, ay) {
                    if (!this.tryPlaceExt(who, id, rot, ax, ay)) continue;
                    if (_r() == r) {
                        for (uint256 j; j < n; ++j) {
                            _cand(ax + cx[j], ay + cy[j] - 1);
                            _cand(ax + cx[j] + 1, ay + cy[j]);
                            _cand(ax + cx[j], ay + cy[j] + 1);
                            _cand(ax + cx[j] - 1, ay + cy[j]);
                        }
                    }
                    return true;
                } catch {}
            }
        }
        return false;
    }

    /// external, so each call gets a fresh memory frame (long loops of calls in one frame run out of memory)
    function growExt(address who, uint256 id, uint256 seed, uint256 tries) external returns (bool) {
        require(msg.sender == address(this));
        return _grow(who, id, seed, tries);
    }

    function tryPlaceExt(address who, uint256 id, uint8 rot, int32 x, int32 y) external returns (bool) {
        require(msg.sender == address(this));
        uint256 r = _r();
        vm.prank(who);
        try m.build(r, noProofs, noIds, _spots1(id, rot, x, y)) { return true; } catch { return false; }
    }

    function bruteOpenExt(uint256 r) external view returns (uint256) {
        return _bruteOpen(r);
    }

    /// open sockets of machine `r` counted cell by cell, and a check that every touching edge matches
    function _bruteOpen(uint256 r) internal view returns (uint256 open) {
        MachineViews.RoundInfo memory info = views.roundInfo(r);
        for (int32 y = info.minY; y <= info.maxY; ++y) {
            for (int32 x = info.minX; x <= info.maxX; ++x) {
                (bool occ, uint256 pid, uint8 s) = m.cellAt(r, x, y);
                if (!occ) continue;
                for (uint8 dir = 1; dir <= 8; dir <<= 1) {
                    (int32 nx, int32 ny) = dir == 1 ? (x, y - 1) : dir == 2 ? (x + 1, y) : dir == 4 ? (x, y + 1) : (x - 1, y);
                    (bool o2, uint256 pid2, uint8 s2) = m.cellAt(r, nx, ny);
                    bool mine = s & dir != 0;
                    if (!o2) {
                        if (mine) ++open;
                        continue;
                    }
                    if (pid2 == pid) {
                        require(!mine, "a socket inside a part");
                        continue;
                    }
                    uint8 opp = dir == 1 ? 4 : dir == 4 ? 1 : dir == 2 ? 8 : 2;
                    require(mine == (s2 & opp != 0), "edges don't match");
                }
            }
        }
    }

    /// The production build rejects `spots` with every possible witness: each outward direction of each cell on the
    /// final bounding box. One stale witness proves nothing; this proves the layout leaves no outward socket at all.
    function _assertSealed(address who, IdentityMachine.Spot[] memory spots) internal {
        MachineViews.RoundInfo memory info = _round();
        (int32 x0, int32 y0, int32 x1, int32 y1) = (info.minX, info.minY, info.maxX, info.maxY);
        for (uint256 i; i < spots.length; ++i) {
            (uint8 n, int32[9] memory xs, int32[9] memory ys,) =
                Shapes.footprint(Catalog.tmplOf(_design(spots[i].id)), spots[i].rot, spots[i].x, spots[i].y);
            for (uint256 j; j < n; ++j) {
                if (xs[j] < x0) x0 = xs[j];
                if (xs[j] > x1) x1 = xs[j];
                if (ys[j] < y0) y0 = ys[j];
                if (ys[j] > y1) y1 = ys[j];
            }
        }
        uint256 r = _r();
        for (int32 y = y0; y <= y1; ++y) {
            for (int32 x = x0; x <= x1; ++x) {
                for (uint8 d = 1; d <= 8; d <<= 1) {
                    bool edge = (d == Shapes.N && y == y0) || (d == Shapes.E && x == x1)
                        || (d == Shapes.S && y == y1) || (d == Shapes.W && x == x0);
                    if (!edge) continue;
                    vm.prank(who);
                    try m.build(r, noProofs, noIds, spots, IdentityMachine.GrowthExit(x, y, d)) {
                        revert("an outward socket remains: the layout is not sealed");
                    } catch (bytes memory err) {
                        assertEq(bytes4(err), IdentityMachine.NoGrowthExit.selector, "rejected for another reason");
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ minting

    function _mint(address who, uint256 n) internal returns (uint256 first, uint256 total) {
        vm.prank(who);
        (first, total) = m.mint(n, type(uint256).max);
    }

    /// randomness for mint `id` to reveal as catalog part `d` (or any part, if d == type(uint16).max)
    function _rig(uint256 id, uint16 d) internal returns (bytes32 r) {
        (, uint48 dr) = m.pending(id);
        if (d != type(uint16).max) {
            require(Shapes.dropOdds(Catalog.tierOf(d), Catalog.tmplOf(d)) != 0, "requested design cannot drop");
        }
        for (uint256 s; s < 100_000; ++s) {
            r = keccak256(abi.encode("r", s, d, id));
            uint256 x = uint256(keccak256(abi.encode(r, id)));
            uint8 tier = m.rollTier(x);
            uint16 got = Catalog.partFor(tier, Shapes.rollDrop(tier, x >> 16), x >> 32);
            if (d == type(uint16).max || got == d) {
                beacon.set(uint64(dr), r);
                return r;
            }
        }
        revert("requested design not found within rig budget");
    }

    /// mint one part for `who` and reveal it as catalog part `d`
    function _get(address who, uint16 d) internal returns (uint256 id) {
        (id,) = _mint(who, 1);
        _rig(id, d);
        m.reveal(_ids(id));
        assertEq(_design(id), d);
        assertEq(parts.ownerOf(id), who);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        (x[0], x[1]) = (a, b);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _round() internal view returns (MachineViews.RoundInfo memory) {
        return views.roundInfo(m.round());
    }
}
