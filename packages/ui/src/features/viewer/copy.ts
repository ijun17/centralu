/**
 * What ⌘C should actually put on the clipboard.
 *
 * Two things stop the browser from getting this right on its own:
 *
 *   - **The viewer is virtualized.** Only the rows near the viewport exist in the DOM, so
 *     the browser's own copy can only serialise what happens to be mounted. Select line 10
 *     to line 500 and the middle simply is not there to copy.
 *   - **The line numbers share the row with the text.** `select-none` on the gutter
 *     suppresses the *visual* highlight, but it is CSS, and CSS does not decide what lands
 *     in the clipboard — Chromium copies that text in plenty of layouts.
 *
 * The data was never the problem: the whole file is in memory. So the payload is rebuilt
 * here from the lines, and the DOM is asked one question only — *where* does the selection
 * start and end. The answer comes back as line/column, which unmounted rows cannot break.
 */

/** A selection endpoint in the file's coordinates, not the DOM's. */
export type Caret = { line: number; column: number }

/** Past the end of any line — "to the end of this row", written before we know the row. */
export const LINE_END = Number.MAX_SAFE_INTEGER

/**
 * One row as the clipboard should see it.
 *
 * `text` is what the row displays and what a caret's column indexes into. `prefix` is what
 * the row draws next to that text but outside it, and still belongs to the line: the diff's
 * +/− marker lives in its own span, and it is drawn as a typographic − that no patch tool
 * accepts. The viewer has no prefix — its gutter is a line number, which belongs to nobody.
 */
export type CopyLine = { text: string; prefix?: string }

/** Shown under a partly-read file, and put on the clipboard with it — see `wholeFileText`. */
export const TRUNCATED_NOTICE = '…file is large; showing part of it. Open in your IDE to see the rest.'

const clamp = (n: number, max: number): number => (n < 0 ? 0 : n > max ? max : n)

/**
 * The text between two carets, in file order.
 *
 * The carets may arrive in either order (dragging upwards is normal), and their columns may
 * be nonsense — `LINE_END`, or an offset into a row that has since been re-measured — so
 * everything is clamped rather than trusted.
 */
export function buildCopyText(lines: CopyLine[], a: Caret, b: Caret): string {
  if (lines.length === 0) return ''
  const forwards = a.line < b.line || (a.line === b.line && a.column <= b.column)
  const [from, to] = forwards ? [a, b] : [b, a]
  const first = clamp(from.line, lines.length - 1)
  const last = clamp(to.line, lines.length - 1)

  const out: string[] = []
  for (let i = first; i <= last; i++) {
    const { text, prefix = '' } = lines[i]!
    const start = i === first ? clamp(from.column, text.length) : 0
    const end = i === last ? clamp(to.column, text.length) : text.length
    // The marker only belongs to the clipboard when the line is taken from its start —
    // a selection that begins mid-line did not cover the marker on screen either.
    out.push((start === 0 ? prefix : '') + text.slice(start, end))
  }
  return out.join('\n')
}

/**
 * The payload for "select all", which is a claim: *this is the file*.
 *
 * When the viewer only holds part of it the claim is false, so the notice the screen shows
 * goes on the clipboard too. Silently handing over half a file is the same bug as copying
 * the mounted rows: it looks complete and is not.
 */
export function wholeFileText(text: string, truncated: boolean): string {
  return truncated ? `${text}\n${TRUNCATED_NOTICE}` : text
}

/**
 * Turn a DOM selection endpoint into a file coordinate.
 *
 * Rows carry `data-line`, and the selectable text inside them carries `data-code`. Anything
 * else in a row is the gutter, which has no column of its own, so an endpoint there reads as
 * the start of the line — which is where the eye puts it anyway, the gutter being left of
 * the text.
 *
 * This keeps working on a row the virtualizer has already unmounted: a detached element
 * still answers `closest()` and still carries its `data-line`. That is the case that matters
 * — during a drag-scroll the row the selection started on is usually gone by the time ⌘C
 * arrives.
 */
export function caretAt(node: Node | null, offset: number): Caret | null {
  if (!node) return null
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const row = el?.closest<HTMLElement>('[data-line]')
  const line = Number(row?.dataset.line)
  if (!row || !Number.isInteger(line)) return null

  const code = row.querySelector('[data-code]')
  const inCode = !!code && code.contains(node)
  // Only a text node carries a real column. On an element the offset counts children, so
  // the two answers it can give are "before everything" and "after everything".
  if (node.nodeType === Node.TEXT_NODE) return { line, column: inCode ? offset : 0 }
  return { line, column: offset > 0 && (inCode || el === row) ? LINE_END : 0 }
}

/**
 * The clipboard text for whatever is selected inside `root`, or null when the selection is
 * not ours to rewrite (leave the browser alone in that case).
 *
 * `lastAnchor` is the escape hatch for the one endpoint that can genuinely vanish. The focus
 * end of a selection is under the pointer, so it is always mounted; the anchor end is where
 * the drag began, and after enough scrolling Chromium re-parents it onto the scroll
 * container, which has no line to report. Remembering the anchor while it was still
 * readable costs one `selectionchange` listener and saves the top half of the selection.
 */
export function selectedText(p: {
  selection: Selection | null
  root: HTMLElement
  lines: CopyLine[]
  lastAnchor: Caret | null
}): string | null {
  const sel = p.selection
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  // A selection made somewhere else is somebody else's copy, whatever anchor was remembered from an earlier one
  if (!sel.getRangeAt(0).intersectsNode(p.root)) return null

  // The anchor is the one end that can be gone from the rows with the drag still going: remembered while it was a row.
  // It is used for an anchor the scrolling walked onto a place in the pane that is on no row (the rows' box), and for a
  // drag whose focus is in the rows. Not for a selection whose anchor is a container elsewhere (a select-all of the page
  // starts at `body`): that is no drag of this pane, and what was remembered belongs to an earlier selection.
  let anchor = caretAt(sel.anchorNode, sel.anchorOffset)
  let focus = caretAt(sel.focusNode, sel.focusOffset)
  const walked = !!sel.anchorNode && p.root.contains(sel.anchorNode)
  if (!anchor && p.lastAnchor && (walked || focus)) anchor = p.lastAnchor
  if (!anchor && !focus) {
    // Both ends outside the rows (a select-all of the page, a drag from the sidebar through the pane to the header):
    // the rows the selection touches, taken whole
    const rows = touchedRows(p.root, sel)
    if (rows.length === 0) return null
    return buildCopyText(p.lines, { line: Number(rows[0]!.dataset.line), column: 0 }, { line: Number(rows.at(-1)!.dataset.line), column: LINE_END })
  }
  if (!anchor) anchor = missingEnd(p.root, sel, sel.anchorNode, sel.focusNode)
  else if (!focus) {
    focus = missingEnd(p.root, sel, sel.focusNode, sel.anchorNode)
    // WebKit can put the end on text laid over the pane (#424) so that the selection touches no row at all: the pane's
    // edge by where that text stands, whatever it is next to
    if (!focus && touchedRows(p.root, sel).length === 0) focus = edgeCaret(p.root, sel.focusNode)
  }
  return anchor && focus ? buildCopyText(p.lines, anchor, focus) : null
}

/** The rows of the pane the selection reaches into, even partly */
const touchedRows = (root: HTMLElement, sel: Selection): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-line]')].filter((r) => sel.containsNode(r, true))

/**
 * Where an end of the selection that is on no row stands in the file, given the end that is on one (`present`).
 *
 * - Inside the pane but on no row (the diff's sticky file band, the rows' box): the pane's top or bottom edge, by which
 *   side of the present end it comes on, the part the person sees selected.
 * - Wholly above or below the pane: the same edge, the one it left by.
 * - Over the pane (the composer laid across its bottom, which comes before it in the document, #424): the edge on that
 *   side of the pane's middle. The document order says nothing here: what is drawn over the pane's lower half is the
 *   lower end of the drag, wherever it stands in the document.
 * - Beside the pane (the sidebar, the chat, the evidence panel): by the document order, which is what the browser
 *   selected. A node that comes before the present end is the start of what is copied, so it is the first line there is
 *   to take, from its start; one that comes after is the end, so the last line, to its end. Taken the other way round, a
 *   drag from row 5 out to the sidebar copied the tail of row 5.
 *
 * Null when it touches no row and has no edge to read.
 */
function missingEnd(root: HTMLElement, sel: Selection, node: Node | null, present: Node | null): Caret | null {
  if (!node) return null
  const before = !!present && !!(present.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)
  const area = root.getBoundingClientRect()
  if (root.contains(node)) return paneEdge(root, area, before ? 'top' : 'bottom')
  // A container that holds the pane (`body` after a select-all) is no place on the screen: only the document order tells
  const at = node.contains(root) ? null : endRect(node)
  if (at) {
    if (at.bottom <= area.top) return paneEdge(root, area, 'top')
    if (at.top >= area.bottom) return paneEdge(root, area, 'bottom')
    if (at.right > area.left && at.left < area.right) return paneEdge(root, area, midpoint(at) >= midpoint(area) ? 'bottom' : 'top')
  }
  const rows = touchedRows(root, sel)
  if (rows.length === 0) return null
  return before ? { line: Number(rows[0]!.dataset.line), column: 0 } : { line: Number(rows.at(-1)!.dataset.line), column: LINE_END }
}

const midpoint = (r: { top: number; bottom: number }): number => (r.top + r.bottom) / 2

/**
 * Where an end of a selection stands on the screen, or null when it stands nowhere (no box: hidden, `display: contents`,
 * an empty text). A text node is measured by its own text, not by its parent, which can be a tall box that straddles the
 * pane's middle while the line of text is at its top; the zero box of an element that is not drawn is not "above".
 */
function endRect(node: Node): DOMRect | null {
  let r: DOMRect | null
  if (node.nodeType === Node.TEXT_NODE) {
    if (typeof document !== 'undefined') {
      const range = document.createRange()
      range.selectNodeContents(node)
      r = range.getBoundingClientRect()
    } else {
      r = node.parentElement?.getBoundingClientRect() ?? null
    }
  } else {
    r = (node as Element).getBoundingClientRect()
  }
  return r && (r.width > 0 || r.height > 0) ? r : null
}

/** The first line showing at the top of the pane, or the last showing at its bottom */
function paneEdge(root: HTMLElement, area: DOMRect, edge: 'top' | 'bottom'): Caret | null {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-line]')].map((r) => ({ r, box: r.getBoundingClientRect() }))
  const line = (r: HTMLElement | undefined) => (r ? Number(r.dataset.line) : NaN)
  if (edge === 'bottom') {
    const last = line(rows.filter((x) => x.box.top < area.bottom).at(-1)?.r)
    return Number.isInteger(last) ? { line: last, column: LINE_END } : null
  }
  const first = line(rows.find((x) => x.box.bottom > area.top)?.r)
  return Number.isInteger(first) ? { line: first, column: 0 } : null
}

/**
 * Where a selection's focus stands when the pointer dragged it out of `root`: the last line
 * showing at the bottom edge when the focus landed in the lower half of the area or below it,
 * the first line showing at the top edge otherwise.
 *
 * Chromium keeps the focus of a drag inside the scroll area it began in. WebKit (the desktop
 * app's WKWebView) puts it on whatever text is nearest the pointer: held below the window, a
 * drag from the viewer ended on the composer's mode button laid over the viewer's bottom, which
 * comes before the viewer in the document, so the selection touched none of the rows and ⌘C
 * copied the app's chrome (#424). The edge is what the person sees selected.
 */
function edgeCaret(root: HTMLElement, node: Node | null): Caret | null {
  if (!node || root.contains(node)) return null
  const at = endRect(node)
  if (!at) return null
  const area = root.getBoundingClientRect()
  return paneEdge(root, area, midpoint(at) >= midpoint(area) ? 'bottom' : 'top')
}
