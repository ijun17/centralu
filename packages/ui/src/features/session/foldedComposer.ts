/**
 * The geometry of a composer folded into a short grid or project-screen panel (`SessionPane`, `foldWhenShort`).
 * Kept apart from the component so a test can hold the two numbers against each other.
 */

/**
 * How much of the folded card shows above the pane's bottom edge at rest, in px.
 *
 * It was 16 (user, 2026-09-11): the card's `pt-1` plus the form's `py-3`, the most that still hid the input field.
 * The owner chose to show more on 2026-11-06 and doubled it, so the top of the input field shows now and a resting
 * card reads as a place to write, not only as an edge. The card is moved, not resized: its measured height, the space
 * reserved under the conversation and the fold thresholds do not follow from this number.
 */
export const FOLDED_SLIVER = 32

/**
 * The detection zone (in px, measured up from the bottom of the pane) that makes a folded composer rise up: the
 * sliver plus 22px of slack for the hand to aim at. It must stay larger than the sliver, or the card's own top edge
 * would lie outside the strip that raises it. It does not rise while the hand is in the middle of the conversation.
 */
export const COMPOSER_REACH = 54
