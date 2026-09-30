/**
 * Is the caret on the **visually** first or last line (the story behind #38)?
 *
 * history.ts used to count lines only by newlines. When a single logical line grows long enough
 * to wrap into two or three visual lines, pressing the up arrow on the wrapped second line has
 * no newline to find, so it was treated as the "first line" and history came up instead of the
 * caret — it looked as though what the person was typing had vanished (reported by a user on
 * 2026-09-07).
 *
 * Counting wrapped lines eventually needs the on-screen coordinates of the character, and a
 * textarea has no API to ask for that. So this builds a **mirror `<div>` with the same width and
 * font**, renders everything up to the caret into it, and reads the y position there. Two rules
 * keep the cost down:
 *
 *  1. If the newline-based check already says it is not the first/last line, this never runs
 *     (the caller filters it out first).
 *  2. The mirror is only rendered the moment an arrow key is pressed — not on every keystroke.
 *     Once a node is created it stays in the document and is reused.
 *
 * When it cannot be measured (an environment with no layout, or zero width), it **returns
 * true** — history must not disappear just because it could not be measured. In that case it
 * quietly falls back to the old behavior (counting newlines only).
 */

/**
 * The pure part that pulls just the first/last-line judgment out of measured values — kept
 * separate so it can be tested without a DOM
 */
export function rowsFromMetrics(
  caretTop: number,
  contentHeight: number,
  lineHeight: number,
): { first: boolean; last: boolean } | null {
  if (!(lineHeight > 0) || !(contentHeight > 0)) return null
  // Half a line of slack — so a fractional height (e.g. 16.5px) does not throw off the row count
  const slack = lineHeight / 2
  return {
    first: caretTop < slack,
    last: caretTop + lineHeight > contentHeight - slack,
  }
}

/**
 * Only one mirror is ever created and reused (attaching and detaching a node on every
 * measurement would trigger layout twice)
 */
let mirror: HTMLDivElement | null = null

function getMirror(): HTMLDivElement {
  if (mirror?.isConnected) return mirror
  const el = document.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  el.dataset.testid = 'caret-mirror'
  document.body.appendChild(el)
  mirror = el
  return el
}

/**
 * Only copies what affects the textarea's line wrapping — color and borders are not needed on
 * an invisible node
 */
const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'lineHeight',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize',
] as const

/**
 * The y position at the caret, the total height, and the line height.
 *
 * Renders **the text after the caret too** into the mirror. When the caret sits in the middle
 * of a word, whether that whole word wraps to the next line depends on the characters after
 * it — rendering only the part before the caret would wrap it at the wrong spot.
 */
function measure(el: HTMLTextAreaElement): { caretTop: number; contentHeight: number; lineHeight: number } | null {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null
  const style = getComputedStyle(el)
  const inner = el.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
  if (!(inner > 0)) return null

  const m = getMirror()
  for (const k of COPIED) m.style[k] = style[k]
  // Padding is already accounted for in the width — applying it again on the mirror would push
  // the y down by that much
  m.style.padding = '0'
  m.style.border = '0'
  m.style.width = `${inner}px`
  m.style.position = 'absolute'
  m.style.top = '0'
  m.style.left = '-9999px'
  m.style.visibility = 'hidden'
  m.style.whiteSpace = style.whiteSpace === 'nowrap' ? 'pre' : 'pre-wrap'
  m.style.overflowWrap = style.overflowWrap === 'normal' ? 'break-word' : style.overflowWrap

  const caret = el.selectionStart ?? 0
  const value = el.value
  m.textContent = value.slice(0, caret)
  const rest = document.createElement('span')
  // If the caret is at the very end of the text, there is nothing to measure — a single period
  // stands in for the height of that spot
  rest.textContent = value.slice(caret) || '.'
  m.appendChild(rest)

  const caretTop = rest.offsetTop
  const contentHeight = m.scrollHeight
  // When line-height is 'normal' it does not come out as a number — render one character and
  // use its height
  let lineHeight = parseFloat(style.lineHeight)
  if (!(lineHeight > 0)) {
    m.textContent = 'x'
    lineHeight = m.scrollHeight
  }
  m.textContent = ''
  return { caretTop, contentHeight, lineHeight }
}

/**
 * Whether the caret is on the first line, counting wrapped lines (returns true if it cannot be
 * measured — falls back to the caller's newline-based judgment)
 */
export function onFirstVisualLine(el: HTMLTextAreaElement): boolean {
  const m = measure(el)
  if (!m) return true
  return rowsFromMetrics(m.caretTop, m.contentHeight, m.lineHeight)?.first ?? true
}

/** Whether the caret is on the last line, counting wrapped lines */
export function onLastVisualLine(el: HTMLTextAreaElement): boolean {
  const m = measure(el)
  if (!m) return true
  return rowsFromMetrics(m.caretTop, m.contentHeight, m.lineHeight)?.last ?? true
}
