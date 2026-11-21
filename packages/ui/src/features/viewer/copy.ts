// What ⌘C puts on the clipboard, rebuilt from the lines in memory: the viewer is virtualized (unmounted rows cannot be
// copied), and Chromium copies the `select-none` gutter's numbers in many layouts. The DOM only says where the selection
// starts and ends, as line and column, which unmounted rows cannot break.

/** A selection endpoint in the file's coordinates, not the DOM's. */
export type Caret = { line: number; column: number }

/** Past the end of any line — "to the end of this row", written before we know the row. */
export const LINE_END = Number.MAX_SAFE_INTEGER

/**
 * One row for the clipboard: `text` is what a caret's column indexes into; `prefix` is drawn outside it but belongs to
 * the line (the diff's +/− marker, in its own span and drawn as a typographic − no patch tool accepts).
 */
export type CopyLine = { text: string; prefix?: string }

/** Shown under a partly-read file, and put on the clipboard with it — see `wholeFileText`. */
export const TRUNCATED_NOTICE = '…file is large; showing part of it. Open in your IDE to see the rest.'

const clamp = (n: number, max: number): number => (n < 0 ? 0 : n > max ? max : n)

/** The text between two carets in file order. They come in either order, with columns `LINE_END` or stale: all is clamped */
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
    // The marker comes only with the line's start, as on screen
    out.push((start === 0 ? prefix : '') + text.slice(start, end))
  }
  return out.join('\n')
}

/** "Select all" claims the whole file, so a partly-read one carries the screen's notice onto the clipboard too */
export function wholeFileText(text: string, truncated: boolean): string {
  return truncated ? `${text}\n${TRUNCATED_NOTICE}` : text
}

/**
 * A DOM selection endpoint as a file coordinate. Rows carry `data-line`, their text `data-code`; an endpoint on the
 * gutter reads as the line's start. Works on a row the virtualizer unmounted (a detached element still answers
 * `closest()`): in a drag-scroll the start row is usually gone by the time ⌘C arrives.
 */
export function caretAt(node: Node | null, offset: number): Caret | null {
  if (!node) return null
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const row = el?.closest<HTMLElement>('[data-line]')
  const line = Number(row?.dataset.line)
  if (!row || !Number.isInteger(line)) return null

  const code = row.querySelector('[data-code]')
  const inCode = !!code && code.contains(node)
  // Only a text node has a real column; on an element the offset counts children: before or after everything
  if (node.nodeType === Node.TEXT_NODE) return { line, column: inCode ? offset : 0 }
  return { line, column: offset > 0 && (inCode || el === row) ? LINE_END : 0 }
}

/**
 * The clipboard text for what is selected inside `root`, or null to leave the copy to the browser. `lastAnchor`: after
 * enough scrolling Chromium re-parents the anchor end onto the scroll container, which has no line (the focus end is
 * under the pointer, always mounted).
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

  // The remembered anchor stands in for one scrolling walked onto no row of the pane, or when the focus is on a row; not
  // for an anchor on a container elsewhere (a page select-all starts at `body`), which belongs to no drag of this pane.
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
    // WebKit can put the end on text laid over the pane, touching no row (#424): the edge on that text's side
    if (!focus && touchedRows(p.root, sel).length === 0) focus = edgeCaret(p.root, sel.focusNode)
  }
  return anchor && focus ? buildCopyText(p.lines, anchor, focus) : null
}

/** The rows of the pane the selection reaches into, even partly */
const touchedRows = (root: HTMLElement, sel: Selection): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-line]')].filter((r) => sel.containsNode(r, true))

/**
 * Where an end on no row stands in the file, given the end on one (`present`); null with no row or edge to read.
 * - Inside the pane (the diff's sticky file band, the rows' box): the top or bottom edge, by its side of `present`.
 * - Wholly above or below the pane: the edge it left by.
 * - Over the pane (the composer across its bottom, earlier in the document, #424): the edge on that side of the pane's
 *   middle; document order says nothing here.
 * - Beside the pane (sidebar, chat, evidence panel): by document order, what the browser selected. Before `present`, the
 *   first line from its start; after, the last line to its end (the other way round, a drag from row 5 out to the
 *   sidebar copied row 5's tail).
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
 * Where a selection end stands on screen, or null (no box: hidden, `display: contents`, empty text; a zero box is not
 * "above"). A text node is measured by its text: its parent can be a tall box straddling the pane's middle.
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
 * A focus dragged out of `root`: the bottom edge's last line when in the lower half or below, else the top edge's first.
 * Chromium keeps a drag's focus in its scroll area; WebKit (WKWebView) puts it on the text nearest the pointer, such as
 * the composer's mode button over the viewer's bottom, earlier in the document, so ⌘C copied the app's chrome (#424).
 */
function edgeCaret(root: HTMLElement, node: Node | null): Caret | null {
  if (!node || root.contains(node)) return null
  const at = endRect(node)
  if (!at) return null
  const area = root.getBoundingClientRect()
  return paneEdge(root, area, midpoint(at) >= midpoint(area) ? 'bottom' : 'top')
}
