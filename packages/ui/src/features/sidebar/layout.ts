import type { CSSProperties } from 'react'

/*
 * One column grid for the whole tree (#685). A row's content (the tool mark or app icon, then the name) starts at
 * x = NAME_X + 16 * level, where NAME_X is the project name's own column (32px). So every level starts one 16px step
 * right of its parent's **content**, not of its parent's chevron.
 *
 * A row is its band: a 2px bar, then the 28px gutter its chevron stands in (GroupToggle), then the content. The band
 * therefore starts 30px before the content, which is the margin below: 32 + 16 * level - 30. The gutter is part of the
 * row at every level, so a sibling with no chevron keeps the same column, and the project's own chevron stands in the
 * 28px left of its name the same way. The values are literal classes so Tailwind finds them.
 *
 * The gutter is wider than the 24px button (DISCLOSURE_BUTTON) that stands in it: the button is centred, so the chevron
 * glyph keeps a few pixels of air from the name it belongs to instead of touching it (it used to end on the name's
 * first letter in the project row).
 */
export const INDENT = { 1: 'ml-[18px]', 2: 'ml-[34px]', 3: 'ml-[50px]', 4: 'ml-[66px]', 5: 'ml-[82px]' } as const
/** The deepest level drawn: a session further in than this stands at it, still under its nearest drawn ancestor (#862) */
export const MAX_LEVEL = 5
/** The guide line a nested row hangs from: 1px just outside its band, so it adds nothing to the row's width */
export const GUIDE = 'before:absolute before:inset-y-0 before:-left-px before:w-px before:bg-line/60 before:content-[""]'
/**
 * The chevron gutter, written once: every place that stands in it or starts after it reads this variable, which the
 * sidebar sets on its root, so a change cannot leave one of them behind. The margins in INDENT do not depend on it
 * (the gutter is both inside the band and subtracted from the name column).
 */
const GUTTER = 28
export const SIDEBAR_VARS = {
  '--sidebar-gutter': `${GUTTER}px`,
  /*
   * The sidebar's lines (dividers, the outlined buttons) stand a step further from its background than elsewhere
   * (styles/index.css, --color-line-side). Only --color-line: line-strong is what a session's tool mark is drawn with,
   * and a mark must look the same in the sidebar as in the header and the grid.
   */
  '--color-line': 'var(--color-line-side)',
} as CSSProperties
export const GUTTER_WIDTH = 'w-(--sidebar-gutter)'
/** The project name's own column, which the leftover "Other apps" title shares: the 2px bar, 2px of padding, then the gutter */
export const NAME_PAD = 'pl-[calc(var(--sidebar-gutter)+4px)]'
/**
 * What a row with a hover menu keeps clear at its right: the ⋯ button (22px) and its 12px margin (right-3) is 34px,
 * so 40px. It was 56px from when a row had two buttons; at the narrowest sidebar the 16px it gives back is what a
 * level-3 name has to show more than its first letter.
 */
export const ROW_MENU_PAD = 'pr-10'
/** What a row's button stands in front of its content: the 2px bar (border-l-2) and, after it, this 28px gutter */
export const ROW_PAD = 'pl-(--sidebar-gutter)'
/** The fold chevron's button, and its glyph: one size for the project row and for every row that folds a group */
export const DISCLOSURE_BUTTON = 'size-6'
export const DISCLOSURE_ICON = 14
