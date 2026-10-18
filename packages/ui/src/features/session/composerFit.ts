/**
 * How tall the composer's text is, for fitting the box to it (#744).
 *
 * The box used to be fitted by reading its own `scrollHeight` at `height: auto`. At that height
 * the box is one row tall, so a text of several rows makes it show a scrollbar, and where a
 * scrollbar takes room (WebKit with classic scrollbars) the text wraps narrower and the box laid
 * the text out one row longer than it ends up: it came out one blank row too tall at some
 * lengths, and the row count read off its height disagreed with the rows on screen (the up arrow
 * went to history a wrapped line early). WebKit even keeps that narrower layout after the
 * scrollbar is gone (`overflow: hidden` on the box does not undo it), so the box itself cannot be
 * asked.
 *
 * So the text is laid out in **a hidden clone of the textarea that never has a scrollbar**: the
 * same font and width, `overflow: hidden`, no height of its own. A textarea rather than a `<div>`,
 * because that is the widget whose wrapping and trailing newline are being measured. The real
 * textarea is only read (its width and its styles), never changed.
 */

let probe: HTMLTextAreaElement | null = null

function getProbe(): HTMLTextAreaElement {
  if (probe?.isConnected) return probe
  const el = document.createElement('textarea')
  el.setAttribute('aria-hidden', 'true')
  el.tabIndex = -1
  el.readOnly = true
  el.dataset.testid = 'composer-fit-probe'
  document.body.appendChild(el)
  probe = el
  return el
}

/** What affects how the text wraps and how tall a row is */
const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariant',
  'fontKerning',
  'fontFeatureSettings',
  'fontVariationSettings',
  'textRendering',
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
 * The height the box needs for its text, padding and border included (the box is `border-box`),
 * or null when it cannot be measured (no layout, or the box is not shown)
 */
export function fitHeight(el: HTMLTextAreaElement): number | null {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null
  const style = getComputedStyle(el)
  const px = (v: string) => parseFloat(v || '0') || 0
  const padding = px(style.paddingTop) + px(style.paddingBottom)
  const border = px(style.borderTopWidth) + px(style.borderBottomWidth)
  const inner = el.offsetWidth - px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth)
  if (!(inner > 0)) return null

  const p = getProbe()
  for (const k of COPIED) p.style[k] = style[k]
  p.style.boxSizing = 'content-box'
  p.style.padding = '0'
  p.style.border = '0'
  p.style.width = `${inner}px`
  p.style.height = '0'
  p.style.minHeight = '0'
  p.style.position = 'absolute'
  p.style.top = '0'
  p.style.left = '-9999px'
  p.style.visibility = 'hidden'
  p.style.overflow = 'hidden'
  p.style.resize = 'none'
  p.value = el.value
  const text = p.scrollHeight
  p.value = ''
  return text + padding + border
}

/** The tallest the composer's text box grows before it scrolls. Must match the box's `max-h-40` */
export const COMPOSER_MAX_H = 160

/**
 * Fits a composer's text box to its value. The session's composer and the one before the orchestrator exists both
 * call it, so a box that grows with its text grows the same way in both (#1143 U17).
 */
export function fitComposerHeight(el: HTMLTextAreaElement): void {
  // Not off the box's own scrollHeight, which can come out a row too many in WebKit (#744)
  const wanted = fitHeight(el)
  if (wanted === null) el.style.height = 'auto'
  el.style.height = `${Math.min(wanted ?? el.scrollHeight, COMPOSER_MAX_H)}px`
}
