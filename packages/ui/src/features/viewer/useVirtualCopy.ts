import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { caretAt, selectedText, type Caret, type CopyLine } from './copy.js'
import { letterOf } from '../../app/keys.js'

/**
 * Copy and ⌘A for a pane with virtualized rows, the code viewer's and the diff's: one rule (#428, #424). Spread the
 * returned props on the scroll area (`scrollRef`), which needs `tabIndex={0}`.
 * - The copy is rebuilt from `lines` (`selectedText`): the DOM holds only the rows near the viewport. A selection that
 *   leaves the pane copies the pane's part (`edgeCaret`); one that does not touch it is left to the browser.
 * - The anchor end is remembered while its row exists: the browser walks it out of the rows once the list scrolls far.
 *   A new `resetKey` or `contentKey` forgets it.
 * - ⌘A claims `wholeText` and paints the mounted rows: with no live selection the browser fires no `copy`. The claim
 *   ends on a mouse press, a selection leaving the rows, or Shift with a key that extends a selection (#842 item 9:
 *   a press alone would let text selected elsewhere copy as the whole file); row recycling keeps it (#36).
 * - The pane takes focus once per `resetKey` when `ready`, so ⌘A lands here: on the document, ⌘C copies only the rows.
 */
export function useVirtualCopy({
  scrollRef,
  rowsRef,
  lines,
  wholeText,
  resetKey,
  contentKey,
  ready,
}: {
  /** The scroll area: where a selection counts as inside the pane, and what takes focus */
  scrollRef: RefObject<HTMLElement | null>
  /** The element that holds the rows, the extent ⌘A paints */
  rowsRef: RefObject<HTMLElement | null>
  /** Every line of the file or diff, in order: what a caret's line number indexes into */
  lines: CopyLine[]
  /** What ⌘A then ⌘C puts on the clipboard; null when there is nothing to claim */
  wholeText: string | null
  /** The file or diff shown: a new key is a new selection context, and the pane takes focus once for each */
  resetKey: string | null
  /** What the pane holds: when it changes under the same `resetKey` (a diff re-read) the anchor and ⌘A's claim are dropped too */
  contentKey?: unknown
  /** The pane has rows on screen (not an error, an image, a binary file, or nothing chosen) */
  ready: boolean
}): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; onScroll: () => void } {
  const whole = useRef(false)
  /** The last readable anchor of the current selection (see `selectedText`) */
  const anchor = useRef<Caret | null>(null)
  const focusedFor = useRef<string | null>(null)
  const latest = useRef({ lines, wholeText })
  latest.current = { lines, wholeText }

  useEffect(() => {
    whole.current = false
    anchor.current = null
  }, [resetKey, contentKey])

  useEffect(() => {
    if (!ready || focusedFor.current === resetKey) return
    focusedFor.current = resetKey
    whole.current = false
    scrollRef.current?.focus()
  }, [ready, resetKey, scrollRef])

  /*
   * Remember the anchor while its row exists: once the row is recycled the browser moves the anchor up into the app
   * chrome, and ⌘C would copy "Files / esc back to chat / Open in IDE". A collapsed selection is a new one, so it
   * overwrites the memory even with null; an anchor a continuing drag walked out of the pane is ignored.
   */
  useEffect(() => {
    if (!ready) return
    const onSelectionChange = () => {
      const sel = document.getSelection()
      const root = scrollRef.current
      if (whole.current) {
        if (!claimStands(sel, rowsRef.current)) whole.current = false
        // Scrolling recycled the painted rows and the live range collapsed with them: paint the rows there now
        else if (sel?.isCollapsed) paintRef.current()
      }
      if (!sel || !root || !sel.anchorNode) return
      if (!root.contains(sel.anchorNode)) {
        // A collapsed caret outside the pane begins a new selection; a drag walked out is not collapsed and keeps its anchor
        if (sel.isCollapsed) anchor.current = null
        return
      }
      const caret = caretAt(sel.anchorNode, sel.anchorOffset)
      if (caret || sel.isCollapsed) anchor.current = caret
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [ready, scrollRef, rowsRef])

  /*
   * ⌘C, scoped by what is selected, not where the event lands: a selection walked out into the app chrome sends its
   * copy event past the pane. So the document listens, and a selection that touches no row of the pane is left alone.
   */
  useEffect(() => {
    if (!ready) return
    const onCopy = (e: ClipboardEvent) => {
      const root = scrollRef.current
      if (!root) return
      const { lines: current, wholeText: all } = latest.current
      const payload =
        whole.current && all !== null && claimStands(document.getSelection(), rowsRef.current)
          ? all
          : selectedText({ selection: document.getSelection(), root, lines: current, lastAnchor: anchor.current })
      if (payload === null) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', payload)
    }
    // Any click starts a new selection, so ⌘A's claim on the clipboard ends there
    const onMouseDown = () => {
      whole.current = false
    }
    // So does extending a selection by keyboard (Shift with an arrow, Home, End or a page key)
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.shiftKey && /^(Arrow|Home$|End$|Page)/.test(e.key)) whole.current = false
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [ready, scrollRef, rowsRef])

  /** Paints the selection over every row that exists right now: with ⌘A the rest is not there to light up */
  const paintMountedRows = () => {
    const el = rowsRef.current
    const sel = document.getSelection()
    if (!el || !sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const paintRef = useRef(paintMountedRows)
  paintRef.current = paintMountedRows

  return {
    onKeyDown: (e) => {
      // ⌘⇧A is the global "next waiting session" and falls through. By meaning: a Korean layout's A types ㅁ (app/keys.ts)
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || letterOf(e) !== 'a') return
      e.preventDefault()
      whole.current = true
      paintMountedRows()
    },
    onScroll: () => {
      if (whole.current) paintMountedRows()
    },
  }
}

/**
 * Whether ⌘A's claim still stands: the selection is still in the rows. Collapsed counts: scrolling recycles the painted
 * rows and the range collapses with them, which is not the person choosing anything else.
 */
function claimStands(sel: Selection | null, rows: HTMLElement | null): boolean {
  if (!sel || !rows || !sel.anchorNode || !sel.focusNode) return false
  return rows.contains(sel.anchorNode) && rows.contains(sel.focusNode)
}
