import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
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
 * Where the conversation's view sits (#428): landing at the bottom or on a search hit when a
 * session opens, returning to the row left behind, following new content while stuck to the
 * bottom, and letting go when the person scrolls. The judgments are scroll.ts's; this is the part
 * that touches the DOM and the store. ChatStream wires the handlers it returns onto its scroller.
 */

/**
 * The number of frames spent settling at the bottom right after the conversation opens (#31).
 *
 * The virtual scroller stretches the total height over several frames as it measures rows.
 * Landing on the bottom has to be redone throughout that — doing it only once leaves it stuck
 * at the pre-measurement height. 30 frames is just a generous ceiling, and it stops immediately
 * the moment the person touches anything.
 */
const LANDING_FRAMES = 30

/** The conversation's mounted rows as laid out, for `laidOutAsMeasured` (#61) */
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
  sticky,
  pending,
  working,
  bottomPad,
}: {
  sessionId: string
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** ChatStream's copy of "was I at the bottom" (see its comment there); the virtualizer reads it too */
  stickToBottom: RefObject<boolean>
  searchTarget: { seq: number; at: number } | null
  sticky: StickyUserState
  pending: SessionSummary['pendingApproval']
  working: boolean
  bottomPad: number | undefined
}) {
  const setStickToBottom = useStore((s) => s.setStickToBottom)
  // A position other than the bottom is remembered as a row (seq) (#61) — it has to be a row,
  // not a pixel, to survive re-measurement
  const setScrollAnchor = useStore((s) => s.setScrollAnchor)
  const clearSearchTarget = useStore((s) => s.clearSearchTarget)
  const { syncSticky, scheduleStickyOverlap } = sticky

  /**
   * The last scroll position this component is aware of — while following, the highest one
   * seen at the bottom (see `stickAfterScroll`).
   *
   * The reference used to judge "did the person scroll up" by **a change in position** rather
   * than a flag: scrollTop stays put even as content grows, but drops when the person scrolls up.
   */
  const lastTop = useRef(0)

  /**
   * When the person last moved the list themselves, and whether a pointer or finger is on it.
   *
   * A drop in scrollTop seen by the follow effect, before its scroll event, only counts as the
   * person's when they did something (`decideFollow`) — layout drops it too. A pointer on the
   * list covers dragging the scrollbar; it stays held until it is released anywhere.
   */
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
    /*
     * A scrolling key is only the list's when it is not typed into a field — the composer's
     * ArrowUp walks the sent history, it does not scroll the conversation — and when it lands on
     * the list or on nothing in particular (the page itself, after a click on the conversation's
     * text), not in another pane.
     */
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current
      const t = e.target
      if (!el || !isScrollUpKey(e) || !(t instanceof Node)) return
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
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

  /**
   * The row currently touching the top of the screen (#61) — updated **on every move, not on
   * leaving**.
   *
   * Computing it at the moment of leaving was tried and failed: the focus view keeps the
   * component and only swaps `sessionId`, but React runs the cleanup function **after**
   * rendering with the new session. By that point, the conversation and measurements at hand
   * already belong to the next session, leaving nothing to ask about the leaving session's
   * position (e2e caught this as a 3,959px jump).
   *
   * So the fact is kept ready ahead of time. Being a ref, it costs no re-render, and since the
   * scroll handler already runs a pass through syncSticky anyway, this only adds one more
   * binary search on top of it.
   */
  const anchor = useRef<{ seq: number; offset: number } | null>(null)

  /**
   * "Was it at the bottom", measured at the moment a scroll actually happened (#61).
   *
   * There are two reasons this is kept separate from `stickToBottom`. One is the same as
   * `anchor` above — the element at the moment the cleanup function runs already belongs to the
   * next session, so it must not be measured there. The other is the reason the original
   * comment gave for "look at position, not the follow flag": the follow effect's release,
   * below, also drops the flag on a drop it sees before the scroll event (while the person's
   * input is fresh), but that is a judgment about a single frame, not an answer to where the
   * person was actually looking. So this is used **only here**, and is only ever written from a
   * scroll event.
   */
  const wasAtBottom = useRef(true)

  // Tracks whether the person scrolled up — does not pull them back down while they have
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // Not `isAtBottom(el)` alone: content that landed since the move makes a view that never
    // moved look far from the bottom (see `stickAfterScroll`)
    const next = stickAfterScroll({ sticking: stickToBottom.current, lastTop: lastTop.current, pos: el })
    stickToBottom.current = next.sticking
    wasAtBottom.current = stickToBottom.current
    lastTop.current = next.lastTop
    /*
     * Not remembered while landing. That scroll was produced by this code, not by the person,
     * and recording an intermediate frame's position as "where they were reading" would send
     * the next arrival straight back to it.
     */
    if (!stillLanding.current) anchor.current = anchorAt(el.scrollTop, virtualizer.measurementsCache, chat)
    // A search landing remains marked while new events or a host catch-up change the list. The
    // next scroll belongs to the reader, so it is the point where the marker is spent.
    if (
      searchTarget &&
      !stillLanding.current &&
      personIsScrolling({ now: performance.now(), lastInputAt: lastInputAt.current, held: held.current })
    )
      clearSearchTarget(sessionId, searchTarget.at)
    syncSticky()
    scheduleStickyOverlap.current()
  }

  /*
   * A different conversation is not always a new component.
   *
   * The grid throws panels away, but the focus view keeps this one and swaps `sessionId`
   * underneath it — so without this, the refs would carry one conversation's position into
   * the next one. Layout effect, so the flag is in place before the follow effect below
   * reads it on the same commit, and so the cleanup runs while the scroll element is still
   * attached.
   */
  const landed = useRef(false)
  const landing = useRef(0)
  const stillLanding = useRef(false)
  const landedSearchAt = useRef<number | null>(null)

  /*
   * The cleanup function has to see the conversation and measurements **from the moment of
   * leaving** (#61).
   *
   * The effect only runs when `sessionId` changes, and the `chat` its closure captured is from
   * the moment it mounted — computing the anchor from that would point at the wrong row, with
   * everything the conversation grew by in between missing entirely. Adding `chat` as a
   * dependency is worse: the effect would re-run every time the conversation grows, restarting
   * landing from scratch every time. So this passes a window onto the value, not the value itself.
   */
  const chatRef = useRef(chat)
  chatRef.current = chat
  const virtRef = useRef(virtualizer)
  virtRef.current = virtualizer

  /**
   * The reader has taken the conversation over, so stop arriving at it (#31).
   *
   * Wheel, a hand on the scrollbar, a key: the three ways a person moves this list. It is
   * their intent we are after, not their scroll — `scrollTop` alone cannot tell a wheel
   * from the browser holding the view still while rows measure.
   */
  const endLanding = () => {
    cancelAnimationFrame(landing.current)
    stillLanding.current = false
    setSettling(false)
  }

  /**
   * **Nothing is shown** while settling into position (#61).
   *
   * Neither landing nor restoring finishes in one frame — the target keeps moving as rows are
   * measured, so it has to be re-aimed at on every frame. Rendering those intermediate
   * positions as-is was the symptom of "even when stuck to the bottom, it starts a bit higher
   * and slides down". What needed fixing was not how many times it re-aims, but **showing the
   * in-between steps at all**.
   *
   * This has to be `visibility: hidden` (not display:none). The virtual scroller measures rows
   * while it renders, and if the layout box disappears, there is nothing left to measure, so it
   * can never settle into position at all. It keeps measuring while hidden, and only appears
   * once its position is settled.
   *
   * It is shown the instant it reaches the target — the loop still holds on for a few more
   * frames after that, but since it is already in place, any further movement is invisible.
   */
  const [settling, setSettling] = useState(false)

  useLayoutEffect(() => {
    // Taken now and closed over: this component renders the scroll element and never
    // replaces it, and refs are attached before layout effects run
    const el = scrollRef.current
    stickToBottom.current = useStore.getState().stickToBottom[sessionId] ?? true
    wasAtBottom.current = stickToBottom.current
    lastTop.current = el?.scrollTop ?? 0
    landed.current = false
    landedSearchAt.current = null
    // The position held for the previous session is released here — without this, the next
    // departure would record it for the wrong session
    anchor.current = null
    return () => {
      cancelAnimationFrame(landing.current)
      /*
       * **The row being viewed** is left behind on the way out (#61).
       *
       * Before anything was left behind here, a non-bottom position was forgotten entirely —
       * coming back, the landing loop did nothing (since it was not at the bottom), and the
       * browser started the fresh element at scrollTop 0, so the result was a jump to the top.
       * The decision not to reuse a raw position was about pixels, but it had drifted into
       * meaning "do not reuse a row" either.
       *
       * Nothing is left behind while still landing — the same reason as `setStickToBottom`
       * below. It is not yet a position the person could actually have held.
       */
      /*
       * The position already held is passed on as-is — this does not recompute it here (see
       * the `anchor` comment above).
       *
       * Whether it was at the bottom is also judged from a ref, not from `el`. The same reason
       * applies: at the point this cleanup runs during a session switch, `el` is the same
       * element **now holding the next session's conversation**, so "was it at the bottom"
       * measured there is not an answer about the session that is leaving. Both refs hold
       * values written at the moment a scroll actually happened.
       */
      if (el && !stillLanding.current) {
        setScrollAnchor(sessionId, wasAtBottom.current ? null : anchor.current)
      }
      /*
       * Hand the fact back on the way out — not on every scroll event.
       *
       * Arriving is itself a scroll: the position is corrected over several frames while
       * rows measure, and each correction fires an event from somewhere that is not yet
       * the bottom. Letting those speak meant a panel could record "was not at the bottom"
       * about a landing still in progress and then honour that on the way back, which
       * reads as the app losing the reader's place at random (it did, under load).
       *
       * Leaving mid-landing says nothing at all, for the same reason: we never got as far
       * as a position the reader could have held. Whatever the session already believed
       * stands.
       *
       * The element is not read here (it was, until #61): by the time this runs on a
       * session switch the same element already holds the *next* conversation, so it
       * answers about the wrong session — it reported "at the bottom" for a session left
       * halfway up, and the anchor saved beside it was then never consulted. `wasAtBottom`
       * is the same fact taken at the only moment it is true: when the reader scrolled.
       * (Still not the follow flag, for the reason its own comment gives.)
       */
      if (el && !stillLanding.current) setStickToBottom(sessionId, wasAtBottom.current)
      stillLanding.current = false
    }
    // chat and virtualizer are read through refs (see the chatRef comment above) — adding them
    // as dependencies would re-run this effect on every growth of the conversation and restart
    // landing from scratch every time
  }, [sessionId, scrollRef, setStickToBottom, setScrollAnchor, stickToBottom])

  /*
   * Arrive at the bottom, once, and keep going until the bottom stops moving.
   *
   * One `scrollTop = scrollHeight` cannot reach the bottom of a list nobody has measured:
   * rows are 64px guesses until they render, so the number we aim at moves while we aim.
   * The panel came to rest a few hundred pixels short of the end (measured: 339px on an
   * 80-turn conversation) — "the scroll has moved up", which is how #31 was reported.
   *
   * The follow effect below cannot do this job. It has to tell "the content grew" from
   * "the reader scrolled up", and it does that by watching `scrollTop` fall — which is
   * also what happens when rows measure smaller than the guess and the browser clamps us.
   * On a settling list that reads as a person scrolling, so it lets go, a few pixels
   * short, permanently. Here we know nobody has touched anything yet.
   *
   * Nor can it be a matter of waiting for the height to hold still: measuring is deferred
   * to a frame of its own and can arrive several frames late, so "two quiet frames" meant
   * finishing before the list had grown at all — 339px short again, and only sometimes,
   * which is worse than always.
   *
   * Waiting for `chat.length` matters — history arrives after the mount, and there is
   * nothing to land on before it does.
   *
   * If the session was **not** at the bottom we do nothing at all. #31 deliberately does
   * not promise the offset back: restoring one into an unmeasured virtualiser is what put
   * the reader *near* their place rather than at it. Not moving is the honest version of
   * that — the reader keeps looking at the old messages instead of being dragged to the
   * newest.
   *
   * It ends early two ways: the reader touches the conversation (`endLanding` on the
   * scroller below), or something drags the view up and away from the end. Both are needed.
   * The first catches the wheel before any number has moved; the second catches everything
   * that scrolls without a gesture to announce it.
   */
  useEffect(() => {
    if (searchTarget && landedSearchAt.current !== searchTarget.at) {
      landed.current = false
      landedSearchAt.current = searchTarget.at
    }
    if (landed.current || chat.length === 0) return
    if (searchTarget) {
      const index = chat.findIndex((c) => c.storedSeq === searchTarget.seq)
      // The history request is still on its way. Do not spend this landing: the effect runs
      // again when that page arrives.
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

    /*
     * If it was not at the bottom, **it returns to the row that was left behind** (#61).
     *
     * This used to just be a `return` here, and that was the entirety of the "back at the top
     * on return" bug. It solves the same problem as landing, but the target is different: the
     * bottom is reachable without measuring anything, but a row's position is only settled once
     * every row above it has been measured. So it re-aims at the target on every frame the same
     * way — the target keeps moving every time a row above it is measured.
     */
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
        // If that row is gone (history was reloaded, say), there is nowhere to return to —
        // rather than force a drop somewhere approximate, this leaves what is currently shown
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
          // The target has stopped moving and the rows above it sit where they were measured: it
          // will not move again, so there is no reason to wait any longer (`laidOutAsMeasured`)
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
      /*
       * Pulled *up* and away from the end — that is somebody else, so stop.
       *
       * Only up counts. When rows above the viewport measure taller than the guess, Chrome
       * moves `scrollTop` down the document by the same amount to hold the view still
       * (scroll anchoring, +32px a frame here); reading any change as a person meant giving
       * up on the third frame, hundreds of pixels short of the end.
       */
      if (mine >= 0 && el.scrollTop < mine - MOVED_UP_SLACK) {
        stillLanding.current = false
        setSettling(false)
        return
      }
      el.scrollTop = el.scrollHeight
      mine = el.scrollTop
      lastTop.current = mine
      // Once it reaches the bottom it is already in place — the loop keeps holding on, but the view shows now
      if (isAtBottom(el)) setSettling(false)
      if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(step)
      else {
        stillLanding.current = false
        setSettling(false)
      }
    }
    landing.current = requestAnimationFrame(step)
    // No cleanup here on purpose: this effect re-runs whenever the conversation grows, and
    // cancelling from there threw the landing away whenever a message arrived first (it
    // did, under load — the panel simply stayed at the top). The frame is cancelled where
    // it actually stops being wanted: when the session changes or the panel goes.
  }, [sessionId, chat, searchTarget, scrollRef, stickToBottom])

  /*
   * Keeps following while stuck to the bottom.
   *
   * The reference used to be `chat.length`, but a streaming response **does not add an item —
   * it grows the last one.** So the view stayed frozen in place while the answer got longer
   * (dogfooding: "at the bottom, but it does not follow when new content appears").
   *
   * Watching the virtual scroller's total height folds both cases into one reference — the
   * total height changes whether an item is added or an existing one grows.
   *
   * Why this corrects once more: a new row is only measured on the next frame, so scrolling
   * down using the `scrollHeight` measured before that falls a few pixels short.
   */
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    /*
     * The landing above is already pinning us every frame, so stay out of its way (#31).
     *
     * Two writers is worse than one here. This one aims once per size change and then asks
     * `decideFollow` whether to let go, and on a list that is still measuring the answer
     * comes back "the reader scrolled up" — which is how the panel ended up a few hundred
     * pixels short of the end and stayed there. Until the landing is done, there is no
     * reader to have scrolled.
     */
    if (stillLanding.current) return

    // What to do is decided by scroll.ts — this only ever touches the DOM
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
      // Decided again from **the current position**, not the judgment made when this was scheduled
      if (!later || !shouldFollowAgain(later)) return
      later.scrollTop = later.scrollHeight
      lastTop.current = later.scrollTop
    })
    return () => cancelAnimationFrame(id)
    // bottomPad: the margin grows too when the card grows (an attachment, more lines) — this
    // follows along if it was stuck to the bottom
  }, [totalSize, pending, working, bottomPad, scrollRef, stickToBottom])

  return { onScroll, endLanding, noteInput, held, settling }
}
