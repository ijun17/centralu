/**
 * Whether the caret is on the visually first or last line, wrapped lines counted (#38). A textarea cannot say where a
 * character is, so a mirror `<div>` of its width and font is measured, only on an arrow key that newlines let through.
 * Unmeasurable (no layout, zero width) answers true, leaving it to the newline count.
 */

/** The judgment from measured values, testable without a DOM */
export function rowsFromMetrics(
  caretTop: number,
  contentHeight: number,
  lineHeight: number,
): { first: boolean; last: boolean } | null {
  if (!(lineHeight > 0) || !(contentHeight > 0)) return null
  // Half a line, for fractional heights (16.5px)
  const slack = lineHeight / 2
  return {
    first: caretTop < slack,
    last: caretTop + lineHeight > contentHeight - slack,
  }
}

// One, kept: attaching and detaching per measurement lays out twice
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

/** What decides wrapping */
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

/** With the text after the caret too: whether a word wraps depends on its characters after the caret */
function measure(el: HTMLTextAreaElement): { caretTop: number; contentHeight: number; lineHeight: number } | null {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null
  const style = getComputedStyle(el)
  const inner = el.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
  if (!(inner > 0)) return null

  const m = getMirror()
  for (const k of COPIED) m.style[k] = style[k]
  // Padding is already out of the width
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
  // At the end, a period stands in to be measured
  rest.textContent = value.slice(caret) || '.'
  m.appendChild(rest)

  const caretTop = rest.offsetTop
  const contentHeight = m.scrollHeight
  // `normal` is no number: one character's height instead
  let lineHeight = parseFloat(style.lineHeight)
  if (!(lineHeight > 0)) {
    m.textContent = 'x'
    lineHeight = m.scrollHeight
  }
  m.textContent = ''
  return { caretTop, contentHeight, lineHeight }
}

export function onFirstVisualLine(el: HTMLTextAreaElement): boolean {
  const m = measure(el)
  if (!m) return true
  return rowsFromMetrics(m.caretTop, m.contentHeight, m.lineHeight)?.first ?? true
}

export function onLastVisualLine(el: HTMLTextAreaElement): boolean {
  const m = measure(el)
  if (!m) return true
  return rowsFromMetrics(m.caretTop, m.contentHeight, m.lineHeight)?.last ?? true
}
