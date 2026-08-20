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

  let anchor = caretAt(sel.anchorNode, sel.anchorOffset) ?? p.lastAnchor
  let focus = caretAt(sel.focusNode, sel.focusOffset)
  if (!anchor || !focus) {
    // An endpoint outside the rows entirely — dragged in from the header, or out into the
    // truncation notice. Fall back to the rows the selection touches, taken whole.
    const rows = [...p.root.querySelectorAll<HTMLElement>('[data-line]')].filter((r) => sel.containsNode(r, true))
    if (rows.length === 0) return null
    anchor ??= { line: Number(rows[0]!.dataset.line), column: 0 }
    focus ??= { line: Number(rows.at(-1)!.dataset.line), column: LINE_END }
  }
  return buildCopyText(p.lines, anchor, focus)
}
