// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Part geometry shared by the machine and the art catalog.
///         y grows downward; sockets N=1 E=2 S=4 W=8; rotation = clockwise quarter turns.
library Shapes {
    uint8 internal constant N = 1;
    uint8 internal constant E = 2;
    uint8 internal constant S = 4;
    uint8 internal constant W = 8;

    uint8 internal constant STRAIGHT = 0;
    uint8 internal constant CORNER = 1;
    uint8 internal constant TEE = 2;
    uint8 internal constant CROSS = 3;
    uint8 internal constant CAP = 4;
    uint8 internal constant LONG = 5;
    uint8 internal constant MANIFOLD = 6;
    uint8 internal constant BAR3 = 7;
    uint8 internal constant ELL = 8;
    uint8 internal constant HUB = 9;
    uint8 internal constant BIGHUB = 10;
    uint8 internal constant REACTOR = 11; // 3x3
    uint8 internal constant COUNT = 12;
    uint8 internal constant MAX_SOCKETS = 8;

    error BadTemplate();

    function template(uint8 t) internal pure returns (uint8 n, int8[9] memory dx, int8[9] memory dy, uint8[9] memory m) {
        if (t == STRAIGHT) {
            (n, m[0]) = (1, E | W);
        } else if (t == CORNER) {
            (n, m[0]) = (1, E | S);
        } else if (t == TEE) {
            (n, m[0]) = (1, E | W | S);
        } else if (t == CROSS) {
            (n, m[0]) = (1, N | E | S | W);
        } else if (t == CAP) {
            (n, m[0]) = (1, S);
        } else if (t == LONG) {
            n = 2;
            m[0] = W;
            (dx[1], m[1]) = (1, E);
        } else if (t == MANIFOLD) {
            n = 2;
            m[0] = W | S;
            (dx[1], m[1]) = (1, E | S);
        } else if (t == BAR3) {
            n = 3;
            m[0] = W;
            (dx[1], m[1]) = (1, N | S);
            (dx[2], m[2]) = (2, E);
        } else if (t == ELL) {
            n = 3;
            m[0] = N | W;
            (dx[1], m[1]) = (1, E);
            (dx[2], dy[2], m[2]) = (1, 1, S);
        } else if (t == HUB) {
            n = 4;
            m[0] = N | W;
            (dx[1], m[1]) = (1, E);
            (dx[2], dy[2], m[2]) = (1, 1, S);
            (dy[3], m[3]) = (1, W);
        } else if (t == BIGHUB) {
            n = 4; // six sockets: opposite corners add a second connection
            m[0] = N | W;
            (dx[1], m[1]) = (1, E);
            (dx[2], dy[2], m[2]) = (1, 1, E | S);
            (dy[3], m[3]) = (1, W);
        } else if (t == REACTOR) {
            n = 9; // eight sockets: a midpoint and a corner on each side
            for (uint256 i; i < 9; ++i) (dx[i], dy[i]) = (int8(int256(i % 3)), int8(int256(i / 3)));
            (m[1], m[3], m[5], m[7]) = (N, W, E, S);
            (m[0], m[2], m[6], m[8]) = (N, E, W, S);
        } else {
            revert BadTemplate();
        }
    }

    function cellCount(uint8 t) internal pure returns (uint256 n) {
        (n,,,) = template(t);
    }

    /// @notice Cells and sockets of template `t` at (x, y) after `rot` quarter turns.
    function footprint(uint8 t, uint8 rot, int32 x, int32 y)
        internal
        pure
        returns (uint8 n, int32[9] memory cx, int32[9] memory cy, uint8[9] memory m)
    {
        int8[9] memory dx;
        int8[9] memory dy;
        (n, dx, dy, m) = template(t);
        for (uint256 i; i < n; ++i) {
            (int32 rx, int32 ry) = (int32(dx[i]), int32(dy[i]));
            uint8 mm = m[i];
            for (uint8 k; k < rot; ++k) {
                (rx, ry) = (-ry, rx);
                mm = ((mm << 1) | (mm >> 3)) & 15;
            }
            (cx[i], cy[i], m[i]) = (x + rx, y + ry, mm);
        }
    }

    /// @notice Per-mille odds of template `t` within `tier`, the same for every mint. Each (tier, template) slot holds
    ///         one catalog part (art/Catalog.sol); 0 = this template never appears in this tier. Every tier sums to 1,000.
    function dropOdds(uint8 tier, uint8 t) internal pure returns (uint256) {
        if (tier == 0) {
            if (t == STRAIGHT) return 220;
            if (t == CORNER) return 220;
            if (t == TEE) return 200;
            if (t == CROSS) return 80;
            if (t == CAP) return 100;
            if (t == LONG) return 180;
        } else if (tier == 1) {
            if (t == CORNER) return 150;
            if (t == TEE) return 200;
            if (t == CROSS) return 150;
            if (t == LONG) return 200;
            if (t == MANIFOLD) return 300;
        } else if (tier == 2) {
            if (t == CROSS) return 200;
            if (t == BAR3) return 250;
            if (t == ELL) return 250;
            if (t == HUB) return 300;
        } else if (tier == 3) {
            if (t == BIGHUB) return 700;
            if (t == REACTOR) return 300;
        } else if (tier == 4) {
            if (t == CROSS) return 1000; // agent cores
        }
        return 0;
    }

    /// @notice Picks a template for `tier` using randomness `x`.
    function rollDrop(uint8 tier, uint256 x) internal pure returns (uint8 t) {
        uint256 r = x % 1000;
        for (t = 0; t < COUNT; ++t) {
            uint256 w = dropOdds(tier, t);
            if (r < w) return t;
            r -= w;
        }
        revert BadTemplate();
    }
}
