/**
 * The geometry of a composer folded into a short grid or project-screen panel (`SessionPane`, `foldWhenShort`).
 * Kept apart from the component so a test can hold the number against what the card does.
 */

/**
 * The detection zone (in px, measured up from the bottom of the pane) that makes a folded composer rise up. A folded
 * card sits wholly below the pane's bottom edge (owner, 2026-11-07), so nothing marks the spot and the strip is the
 * only way a hand reaches it: 54px is easy to aim at, and the card does not rise while the hand is in the middle of
 * the conversation. It was the 16–32px sliver plus slack when a sliver showed; the value stayed.
 */
export const COMPOSER_REACH = 54
