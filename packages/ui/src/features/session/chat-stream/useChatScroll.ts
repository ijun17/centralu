import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { isTextEntry } from '../../../app/keys.js'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { SessionSummary } from '@cc/core'
import { useStore, type ChatItem } from '../../../store/store.js'
import type { StickyUserState } from './StickyUser.jsx'
import {
  anchorAt,
  decideFollow,
  isAtBottom,
  isScrollUpKey,
  laidOutAsMeasured,
  MOVED_UP_SLACK,
  personIsScrolling,
  shouldFollowAgain,
  stickAfterScroll,
  type LaidOutRow,
} from '../scroll.js'

/*
 * Where the conversation's view sits (#428), the DOM and store side of scroll.ts's judgments; the
 * rules are docs/state-management.md "The conversation's scroll position".
 */

/** A generous ceiling on frames spent arriving (#31) */
const LANDING_FRAMES = 30

function mountedRows(scroller: HTMLElement): LaidOutRow[] {
  return [...scroller.querySelectorAll<HTMLElement>('[data-index]')].map((row) => ({
    index: Number(row.dataset.index),
    top: row.offsetTop,
    height: row.getBoundingClientRect().height,
  }))
}

export function useChatScroll({
  sessionId,
  scrollRef,
  chat,
  virtualizer,
  stickToBottom,
  searchTarget,
  syncSticky,
  scheduleStickyOverlap,
  pending,
  working,
  bottomPad,
}: {
  sessionId: string
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** ChatStream's, read by the virtualizer too */
  stickToBottom: RefObject<boolean>
  searchTarget: { seq: number; at: number } | null
  syncSticky: StickyUserState['syncSticky']
  scheduleStickyOverlap: StickyUserState['scheduleStickyOverlap']
  pending: SessionSummary['pendingApproval']
  working: boolean
  bottomPad: number | undefined
}) {
  const setStickToBottom = useStore((s) => s.setStickToBottom)
  const setScrollAnchor = useStore((s) => s.setScrollAnchor)
  const clearSearchTarget = useStore((s) => s.clearSearchTarget)

  /** The last scrollTop seen; while following, the highest seen at the bottom (`stickAfterScroll`) */
  const lastTop = useRef(0)

  // The person's last input on the list, and a pointer held on it (the scrollbar), released anywhere
  const lastInputAt = useRef(-Infinity)
  const held = useRef(false)
  const noteInput = () => {
    lastInputAt.current = performance.now()
  }
  useEffect(() => {
    const release = () => {
      if (!held.current) return
      held.current = false
      noteInput()
    }
    // Not in a field (the composer's ArrowUp walks history) nor another pane; the body counts, as
    // a click on the conversation's text leaves focus there
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current
      const t = e.target
      if (!el || !isScrollUpKey(e) || !(t instanceof Node)) return
      if (isTextEntry(t)) return
      if (el.contains(t) || t === document.body || t === document.documentElement) noteInput()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('touchend', release)
    window.addEventListener('touchcancel', release)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('touchend', release)
      window.removeEventListener('touchcancel', release)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [scrollRef])

  // The row at the top of the view, and whether it was at the bottom, taken on every scroll, as the
  // cleanup on leaving runs after the next session has rendered (#61, the doc's third rule).
  // `wasAtBottom` is not `stickToBottom`: the follow effect also drops that on a single frame's guess.
  const anchor = useRef<{ seq: number; offset: number } | null>(null)
  const wasAtBottom = useRef(true)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const next = stickAfterScroll({ sticking: stickToBottom.current, lastTop: lastTop.current, pos: el })
    stickToBottom.current = next.sticking
    wasAtBottom.current = stickToBottom.current
    lastTop.current = next.lastTop
    if (!stillLanding.current) anchor.current = anchorAt(el.scrollTop, virtualizer.measurementsCache, chat)
    // A search hit stays marked through new events and catch-ups until the reader's own scroll
    if (
      searchTarget &&
      !stillLanding.current &&
      personIsScrolling({ now: performance.now(), lastInputAt: lastInputAt.current, held: held.current })
    )
      clearSearchTarget(sessionId, searchTarget.at)
    syncSticky()
    scheduleStickyOverlap.current()
  }

  // Reset per session in a layout effect: the focus view keeps this component and swaps `sessionId`,
  // the follow effect reads the flag in the same commit, and the cleanup runs while the element is attached
  const landed = useRef(false)
  const landing = useRef(0)
  const stillLanding = useRef(false)
  const landedSearchAt = useRef<number | null>(null)

  // Read through refs: as dependencies they would restart arriving on every growth (#61)
  const chatRef = useRef(chat)
  chatRef.current = chat
  const virtRef = useRef(virtualizer)
  virtRef.current = virtualizer

  // The reader took over (#31): `scrollTop` alone cannot tell a wheel from the browser holding the view while rows measure
  const endLanding = () => {
    cancelAnimationFrame(landing.current)
    stillLanding.current = false
    setSettling(false)
  }

  // Hidden while arriving (#61), shown the moment the aim holds
  const [settling, setSettling] = useState(false)

  useLayoutEffect(() => {
    const el = scrollRef.current
    stickToBottom.current = useStore.getState().stickToBottom[sessionId] ?? true
    wasAtBottom.current = stickToBottom.current
    lastTop.current = el?.scrollTop ?? 0
    landed.current = false
    landedSearchAt.current = null
    anchor.current = null
    return () => {
      cancelAnimationFrame(landing.current)
      // From the refs, not `el`, which already holds the next session; nothing while still arriving
      if (el && !stillLanding.current) {
        setScrollAnchor(sessionId, wasAtBottom.current ? null : anchor.current)
      }
      if (el && !stillLanding.current) setStickToBottom(sessionId, wasAtBottom.current)
      stillLanding.current = false
    }
  }, [sessionId, scrollRef, setStickToBottom, setScrollAnchor, stickToBottom])

  /*
   * Arrives at a search hit, the row left behind or the bottom (#31, #61; the doc's second rule).
   * Not the follow effect's job: it reads a falling `scrollTop` as the reader, and a settling list
   * lowers it too. Not "wait for two quiet frames": measuring can come several frames late. History
   * arrives after the mount, hence `chat.length`. Ends on the reader's input (`endLanding`) or on
   * anything else pulling the view up from the end.
   */
  useEffect(() => {
    if (searchTarget && landedSearchAt.current !== searchTarget.at) {
      landed.current = false
      landedSearchAt.current = searchTarget.at
    }
    if (landed.current || chat.length === 0) return
    if (searchTarget) {
      const index = chat.findIndex((c) => c.storedSeq === searchTarget.seq)
      // Its page is still on the way; the effect runs again when it arrives
      if (index < 0) return
      landed.current = true
      stickToBottom.current = false
      wasAtBottom.current = false
      let frames = 0
      let prev = -1
      stillLanding.current = true
      setSettling(true)
      const seek = () => {
        const el = scrollRef.current
        if (!el) return
        const targetIndex = chatRef.current.findIndex((c) => c.storedSeq === searchTarget.seq)
        const m = targetIndex < 0 ? undefined : virtRef.current.measurementsCache[targetIndex]
        if (!m) return
        const target = Math.max(0, m.start - Math.max(0, (el.clientHeight - m.size) / 2))
        el.scrollTop = target
        lastTop.current = el.scrollTop
        if (Math.abs(target - prev) <= 1 && laidOutAsMeasured(mountedRows(el), targetIndex, m.start)) setSettling(false)
        prev = target
        if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(seek)
        else {
          stillLanding.current = false
          setSettling(false)
        }
      }
      landing.current = requestAnimationFrame(seek)
      return
    }
    landed.current = true

    // The row left behind (#61): its place settles only once every row above it is measured
    if (!stickToBottom.current) {
      const anchor = useStore.getState().scrollAnchor[sessionId]
      if (!anchor) return
      let frames = 0
      let prev = -1
      stillLanding.current = true
      setSettling(true)
      const seek = () => {
        const el = scrollRef.current
        if (!el) return
        const index = chatRef.current.findIndex((c) => c.seq === anchor.seq)
        // The row is gone (history reloaded): stay rather than land somewhere approximate
        if (index < 0) {
          stillLanding.current = false
          setSettling(false)
          return
        }
        const m = virtRef.current.measurementsCache[index]
        if (m) {
          const target = m.start + anchor.offset
          el.scrollTop = target
          lastTop.current = el.scrollTop
          if (Math.abs(target - prev) <= 1 && laidOutAsMeasured(mountedRows(el), index, m.start)) setSettling(false)
          prev = target
        }
        if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(seek)
        else {
          stillLanding.current = false
          setSettling(false)
        }
      }
      landing.current = requestAnimationFrame(seek)
      return
    }

    let frames = 0
    let mine = -1
    stillLanding.current = true
    setSettling(true)
    const step = () => {
      const el = scrollRef.current
      if (!el) return
      // Only a pull up is someone else: Chrome's scroll anchoring moves `scrollTop` down (+32px a
      // frame here) as rows above measure taller, and any change would stop on the third frame
      if (mine >= 0 && el.scrollTop < mine - MOVED_UP_SLACK) {
        stillLanding.current = false
        setSettling(false)
        return
      }
      el.scrollTop = el.scrollHeight
      mine = el.scrollTop
      lastTop.current = mine
      if (isAtBottom(el)) setSettling(false)
      if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(step)
      else {
        stillLanding.current = false
        setSettling(false)
      }
    }
    landing.current = requestAnimationFrame(step)
    // No cleanup: this re-runs on every growth, and cancelling there would throw the arrival away when a
    // message comes first (under load the panel stayed at the top). The session's change or the unmount cancels it.
  }, [sessionId, chat, searchTarget, scrollRef, stickToBottom])

  // Follows the total height, not `chat.length`: a streamed answer grows its last row. Once more on
  // the next frame, where a new row is measured.
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // One writer while arriving (#31): `decideFollow` on a measuring list would let go short of the end
    if (stillLanding.current) return

    const decision = decideFollow({
      sticking: stickToBottom.current,
      scrollTop: el.scrollTop,
      lastTop: lastTop.current,
      touched: personIsScrolling({ now: performance.now(), lastInputAt: lastInputAt.current, held: held.current }),
    })
    if (decision === 'ignore') return
    if (decision === 'release') {
      stickToBottom.current = false
      return
    }

    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    const id = requestAnimationFrame(() => {
      const later = scrollRef.current
      if (!later || !shouldFollowAgain(later)) return
      later.scrollTop = later.scrollHeight
      lastTop.current = later.scrollTop
    })
    return () => cancelAnimationFrame(id)
    // bottomPad grows with the composer card
  }, [totalSize, pending, working, bottomPad, scrollRef, stickToBottom])

  return { onScroll, endLanding, noteInput, held, settling }
}
