import type { CSSProperties } from 'react'

/*
 * One column grid for the tree (#685): a row's content starts at 32 + 16 * level (32 is the project name's column), one
 * step right of its parent's content. A row is a 2px bar, the 28px chevron gutter (also on rows with no chevron), then
 * the content, so the margin is 32 + 16 * level - 30. Literal classes so Tailwind finds them. The gutter is wider than
 * the centred 24px button, so the chevron keeps air from the name.
 */
export const INDENT = { 1: 'ml-[18px]', 2: 'ml-[34px]', 3: 'ml-[50px]', 4: 'ml-[66px]', 5: 'ml-[82px]' } as const
/** The deepest level drawn: a session further in than this stands at it, still under its nearest drawn ancestor (#862) */
export const MAX_LEVEL = 5
/** The guide line a nested row hangs from: 1px just outside its band, so it adds nothing to the row's width */
export const GUIDE = 'before:absolute before:inset-y-0 before:-left-px before:w-px before:bg-line/60 before:content-[""]'
/** The chevron gutter, set once on the sidebar's root; INDENT's margins do not depend on it */
const GUTTER = 28
export const SIDEBAR_VARS = {
  '--sidebar-gutter': `${GUTTER}px`,
  // Sidebar lines a step stronger (--color-line-chrome). Not line-strong: tool marks use it and must match the header and grid
  '--color-line': 'var(--color-line-chrome)',
} as CSSProperties
export const GUTTER_WIDTH = 'w-(--sidebar-gutter)'
/** The project name's own column, which the leftover "Other apps" title shares: the 2px bar, 2px of padding, then the gutter */
export const NAME_PAD = 'pl-[calc(var(--sidebar-gutter)+4px)]'
/**
 * Clear right of a row with a hover menu: ⋯ (22px) + right-3 = 34px. Not 56px: at the narrowest sidebar a level-3
 * name needs those 16px.
 */
export const ROW_MENU_PAD = 'pr-10'
/** What a row's button stands in front of its content: the 2px bar (border-l-2) and, after it, this 28px gutter */
export const ROW_PAD = 'pl-(--sidebar-gutter)'
/** The fold chevron's button, and its glyph: one size for the project row and for every row that folds a group */
export const DISCLOSURE_BUTTON = 'size-6'
export const DISCLOSURE_ICON = 14
