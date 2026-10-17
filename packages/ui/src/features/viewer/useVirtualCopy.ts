import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { caretAt, selectedText, type Caret, type CopyLine } from './copy.js'
import { letterOf } from '../../app/keys.js'

/**
 * Copy and ⌘A for a pane whose rows are virtualized: the code viewer and the diff (#428).
 *
 * Both panes had their own copy of this and the copies drifted: the diff let the browser copy whatever a selection that
 * ended outside the pane covered (chrome included), the viewer copied the pane's part only (#424); the diff forgot the
 * remembered anchor on a new file, the viewer did not; ⌘A in the diff painted the sticky file band too, in the viewer
 * only the rows. They now share one rule, the viewer's:
 *
 * - **What is copied is rebuilt from `lines`**, not read off the DOM, which holds only the rows near the viewport
 *   (`selectedText`). A selection that ends outside the pane copies the pane's part (the edge it left by, `edgeCaret`);
 *   a selection that does not touch the pane is left to the browser.
 * - **The anchor end is remembered while its row still exists.** The focus end is under the pointer and always
 *   mounted; the anchor end is where the drag began, and the browser walks it out of the rows once the list scrolls far
 *   enough. It is forgotten when `resetKey` or `contentKey` changes, so one file's anchor never leaks into the next.
 * - **⌘A claims the whole of `wholeText`** and paints the rows that exist, nothing else: the highlight keeps a live
 *   selection alive (without one the browser fires no `copy`), and repainting on scroll keeps it under the eye. The
 *   claim lasts only while that selection does (#842 item 9): any press of the mouse ends it, and so does a selection
 *   that collapses or moves out of the rows. It used to end on a mouse press only, so after ⌘A here, text selected by
 *   keyboard anywhere else (the composer, a field) copied as the whole file.
 * - **The pane takes focus once per `resetKey`** once it has rows (`ready`), so ⌘A has somewhere to land: it is not a
 *   text field, and with focus left on the sidebar button that opened it ⌘A went to the document and ⌘C then copied
 *   only the mounted rows (#118). Once per key, so it never steals focus back from a search box mid-typing.
 *
 * Spread the returned props on the scroll area (`scrollRef`), which needs `tabIndex={0}`.
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
   * Remember where the selection began, while the row it began on still exists.
   *
   * The reported garbage came from here: once the anchor's row is recycled the browser puts the anchor somewhere
   * else, out of the rows and up into the app chrome, and ⌘C copied "Files / esc back to chat / Open in IDE". Reading
   * it while it is still a row is what lets the copy handler serve lines 3…N instead.
   *
   * A collapsed selection is a *new* one beginning, in the rows or outside them, so it overwrites the memory even with
   * null; otherwise a stale anchor would leak into the next copy. An anchor that has been walked out of the pane by a
   * drag that goes on is not an answer to anything, so it is ignored rather than stored.
   */
  useEffect(() => {
    if (!ready) return
    const onSelectionChange = () => {
      const sel = document.getSelection()
      const root = scrollRef.current
      if (whole.current && !claimHolds(sel, rowsRef.current)) whole.current = false
      if (!sel || !root || !sel.anchorNode) return
      if (!root.contains(sel.anchorNode)) {
        // A selection that begins outside the pane (the caret is collapsed there) is a new one: what was remembered
        // belongs to the last one. A drag that has been walked out is not collapsed, and keeps its anchor.
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
   * ⌘C. Scoped by *what is selected*, not by where the event lands: once the browser has walked the selection out into
   * the app chrome the copy event no longer passes through the pane at all, and the one case that has to be caught is
   * the one that escapes. So the listener is on the document and asks a narrower question — does this selection touch
   * the pane's rows? If not, it is somebody else's copy and is left alone.
   */
  useEffect(() => {
    if (!ready) return
    const onCopy = (e: ClipboardEvent) => {
      const root = scrollRef.current
      if (!root) return
      const { lines: current, wholeText: all } = latest.current
      const payload =
        whole.current && all !== null && claimHolds(document.getSelection(), rowsRef.current)
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
    document.addEventListener('copy', onCopy)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('mousedown', onMouseDown)
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

  return {
    onKeyDown: (e) => {
      // Both modifiers, like every other shortcut here. ⌘⇧A is the global "next waiting session" and must fall through
      // Read by meaning, as every letter shortcut here: on a Korean layout the A key types ㅁ (app/keys.ts)
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

/** Whether ⌘A's painted selection still stands: not collapsed, and both its ends inside the rows */
function claimHolds(sel: Selection | null, rows: HTMLElement | null): boolean {
  if (!sel || !rows || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return false
  return rows.contains(sel.anchorNode) && rows.contains(sel.focusNode)
}
