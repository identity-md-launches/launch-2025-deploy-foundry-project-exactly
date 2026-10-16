import { TIER_CLASS, TIER_NAME } from "./geometry";

// Rarity in gacha colours: common grey, uncommon blue, rare purple, legendary gold; Agent Cores cyan. A coloured
// caps tag replaces the old pips; tooltips, tiles and cards take the same colour (style.css: --common .. --seat).

/** the rarity as a coloured caps tag (HTML; the name is a fixed word, never user input) */
export const rarityTag = (tier: number) => `<span class="rar ${TIER_CLASS[tier]}">${TIER_NAME[tier]}</span>`;
