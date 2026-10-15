import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { SessionSummary } from '@cc/core'
import { inlineFrameShown, useStore, type ChatItem } from '../../../store/store.js'
import { ApprovalCard } from '../../approval/ApprovalCard.jsx'
import { QuestionCard } from '../../approval/QuestionCard.jsx'
import { ChatRow } from '../chat-rows/ChatRow.jsx'
import { ActivityRow } from './ActivityRow.jsx'
import { OlderSentinel } from './OlderSentinel.jsx'
import {
  anchorAt,
  decideFollow,
  forgetUnlistedSizes,
  isAtBottom,
  isScrollUpKey,
  laidOutAsMeasured,
  MOVED_UP_SLACK,
  personIsScrolling,
  shouldFollowAgain,
  rowKeys,
  stickAfterScroll,
  writeScroll,
  type LaidOutRow,
} from '../scroll.js'

/*
 * A session's conversation as a virtual list (#428): the rows, the pinned banner for the turn
 * being read, the cards still waiting on the person, and the activity row at the end.
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

/**
 * The conversation stream — virtual scrolling (D-1).
 *
 * Once a single session reaches hundreds of turns, rendering everything might hold up, but
 * scrolling breaks down. This renders only what is on screen, while keeping two guarantees:
 *   1. It sticks to the bottom automatically while streaming, but **never interrupts a person
 *      who has scrolled up to read**
 *   2. The approval card is always the last item — nothing pending should have to be found by
 *      scrolling
 */
export function ChatStream({
  scrollRef,
  chat,
  pending,
  questions,
  sessionId,
  projectRoot,
  working,
  activity,
  bottomPeek = false,
  bottomPad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  pending: SessionSummary['pendingApproval']
  questions: SessionSummary['pendingQuestions']
  sessionId: string
  projectRoot: string | null
  working: boolean
  activity: SessionSummary['activity']
  /**
   * A collapsed composer covers a bit of the bottom — this reserves margin so the last line is
   * never permanently hidden under it
   */
  bottomPeek?: boolean
  /**
   * The height (px) of the raised input card. When set, the margin below grows by **exactly
   * that card's height**.
   *
   * Collapsed originally meant "overlay instead of pushing" — the row being read not moving on
   * rise looked like the right virtue. In practice, the cost of that virtue turned out to be
   * **not being able to read the last few lines** (reported by a user on 2026-09-13: "it
   * covers the conversation as it rises, which is annoying"). So instead of overlaying, this
   * pushes the content up. The value has to match the card's actual height, so it takes a
   * measured number rather than a constant — the card grows when an attachment is added or the
   * input field wraps to more than one line.
   */
  bottomPad?: number
}) {
  // File links should open in this pane's project (#182) — not the focused session's
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId ?? null)
  /*
   * "Was I at the bottom" is the session's fact, not this component's (issue #31).
   *
   * It stays a ref here because the follow logic reads it from a scroll handler and from
   * effects — re-rendering on it would mean re-rendering on every scroll — but the ref is
   * only a copy. The session holds the original, so a panel that is torn down and built
   * again does not get to decide for itself where the person was.
   */
  const stickToBottom = useRef(true)
  const setStickToBottom = useStore((s) => s.setStickToBottom)
  // A position other than the bottom is remembered as a row (seq) (#61) — it has to be a row,
  // not a pixel, to survive re-measurement
  const setScrollAnchor = useStore((s) => s.setScrollAnchor)
  const searchTarget = useStore((s) => s.searchTargets[sessionId] ?? null)
  const clearSearchTarget = useStore((s) => s.clearSearchTarget)

  /*
   * A row rendering an in-conversation app view is never detached (M4 B-1). The virtual
   * scroller detaches rows that scroll far out of view from the DOM, and if that row has an app
   * view (an iframe), its window disappears the moment it is detached, so any teardown sent
   * after that never arrives. So a row like that is held onto (rangeExtractor, below) even once
   * it falls outside its natural range, and is given `leaving` — once the view sends teardown
   * and collapses into the placeholder, the handle is unregistered (inlineFramesVersion), and
   * only then does the row actually get detached.
   */
  const inlineFramesVersion = useStore((s) => s.inlineFramesVersion)
  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range)
      if (inlineFramesVersion === 0) return base
      const first = base[0] ?? 0
      const last = base[base.length - 1] ?? -1
      const held: number[] = []
      chat.forEach((item, i) => {
        if ((i < first || i > last) && item.kind === 'tool' && item.callId && inlineFrameShown(sessionId, item.callId)) held.push(i)
      })
      return held.length ? [...base, ...held].sort((a, b) => a - b) : base
    },
    [chat, sessionId, inlineFramesVersion],
  )
  // Never two rows under one key: a shared key leaves copies of a row behind in the DOM (#64, `rowKeys`)
  const keys = useMemo(() => rowKeys(chat), [chat])
  const virtualizer = useVirtualizer({
    count: chat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: CHAT_OVERSCAN,
    rangeExtractor,
    /*
     * Defers height measurement to the next frame.
     *
     * With the default (false), the ResizeObserver callback calls flushSync immediately, and
     * React 19 dumps a warning when it encounters that mid-render (8 lines in the dev log
     * reading "flushSync was called from inside a lifecycle method"). Real errors must not be
     * allowed to get buried under that noise.
     */
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (i) => keys[i] ?? `row@${i}`,
    /*
     * The scroller's size-change compensation is applied to where the view is now, not to the
     * offset the scroller last saw in a scroll event — which is a frame stale right after our
     * own landing or following write, and put the view 54px above the end in WebKit. While the
     * view sticks to the end there is none at all (see `writeScroll`).
     */
    scrollToFn: (offset, options, instance) => {
      if (instance.scrollElement) writeScroll(instance.scrollElement, offset, options, stickToBottom.current)
    },
  })
  /*
   * The focus view's pane is one instance for every session it shows, and the scroller never
   * forgets a measured height, so its cache would keep one for every row ever shown (#392). Pruned
   * here, during render, so the heights the next layout reads are already the list's own.
   */
  forgetUnlistedSizes(virtualizer.itemSizeCache, keys)

  /*
   * The **most recent message I sent** that has now scrolled past the top of the screen.
   *
   * `position: sticky` cannot be used — virtual scrolling's rows are placed with absolute
   * positioning, so sticky never takes hold. Instead, this computes "which turn is being
   * viewed" from the scroll position and floats it as a single row above the list.
   *
   * Looking only at rendered rows would miss a message pushed far off screen. `measurementsCache`
   * holds the position of every row already measured, so this uses that instead.
   */
  const [stickyIndex, setStickyIndex] = useState<number | null>(null)
  /**
   * The actual card's rectangle — held so its overlap with the next user message can be
   * measured in DOM coordinates.
   */
  const stickyRef = useRef<HTMLDivElement>(null)
  /**
   * The scroll handler runs first, and the card is rendered after it. The function that
   * measures against the latest DOM is plugged in afterward.
   */
  const scheduleStickyOverlap = useRef<() => void>(() => {})

  const syncSticky = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    let found: number | null = null
    for (const m of virtualizer.measurementsCache) {
      // The criterion is the row's **end**, not its start. Floating another copy above a row
      // that is still half visible would show the same message twice — this only attaches once
      // a row has fully passed.
      if (m.end > top) break // From here on, rows are still on screen or below it
      if (chat[m.index]?.kind === 'user') found = m.index
    }
    setStickyIndex(found)
    // scrollRef is a **prop received** by this component — unlike a ref created inside it, it can change
  }, [chat, virtualizer, scrollRef])

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
  }, [sessionId, scrollRef, setStickToBottom, setScrollAnchor])

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
  }, [sessionId, chat, searchTarget, scrollRef])

  // When content grows, the reference point changes even without a scroll
  useEffect(syncSticky, [syncSticky, chat.length])

  const pinned = stickyIndex !== null ? chat[stickyIndex] : undefined
  // A directive that came from delegation is still "what is being worked on right now", so it
  // is pinned too, but its source is prefixed so it is never disguised as the person's own
  // words (FR-11)
  // A message that sent only an image has empty text — the banner shows the attachment name in its place
  const pinnedText =
    pinned?.kind === 'user' ? pinned.text || (pinned.attachments?.map((a) => a.name).join(', ') ?? '') : null
  const stickyText =
    pinned?.kind === 'user' && pinnedText
      ? pinned.from
        ? `${pinned.from.name} ⤷ ${pinnedText}`
        : pinned.fromApp
          ? `${pinned.fromApp.name} app ⤷ ${pinnedText}`
          : pinnedText
      : null

  // Collapsed by default — moving to a different turn does not carry the expanded state along
  const [stickyOpen, setStickyOpen] = useState(false)
  const [stickyObscured, setStickyObscured] = useState(false)
  /** Returning from the next user message animates top-to-bottom instead of the usual bottom-to-top entry. */
  const [stickyReturning, setStickyReturning] = useState(false)
  const wasStickyObscured = useRef(false)
  useEffect(() => {
    setStickyOpen(false)
    setStickyObscured(false)
    setStickyReturning(false)
    wasStickyObscured.current = false
  }, [stickyIndex])

  /*
   * If the next user message comes in under the pinned banner, one of the two has to disappear.
   *
   * This originally only pinned "the most recent user message that has fully passed", and kept
   * drawing the banner even once the next user message met it. That clipped the next turn's
   * actual text under the card, unreadable at the exact moment someone was trying to read the
   * question. Using only the virtual list's measurements would miss the card's actual wrapped
   * height and open/closed state, so this directly compares the rendered rectangle of the next
   * user row on screen against the banner's rectangle.
   *
   * `requestAnimationFrame` guarantees this measures after the render that the scroll event's
   * `stickyIndex` update produced. At the instant of the event, the old banner is still sitting
   * in the DOM, and judging from its rectangle would either update a frame late or hide
   * incorrectly.
   */
  const overlapFrame = useRef(0)
  const syncStickyOverlap = useCallback(() => {
    const stream = scrollRef.current
    const banner = stickyRef.current
    if (!stream || !banner || stickyIndex === null || stickyText === null) {
      setStickyObscured(false)
      return
    }
    const bannerRect = banner.getBoundingClientRect()
    const nextUser = [...stream.querySelectorAll<HTMLElement>('[data-index]')].find((row) => {
      const index = Number(row.dataset.index)
      return index > stickyIndex && chat[index]?.kind === 'user'
    })
    if (!nextUser) {
      setStickyObscured(false)
      return
    }
    const nextRect = nextUser.getBoundingClientRect()
    // Steps aside 4px early — even a single frame with the edges just touching reads as "the
    // text is under the card"
    const covered = nextRect.top < bannerRect.bottom + 4 && nextRect.bottom > bannerRect.top
    setStickyObscured(covered)
  }, [chat, scrollRef, stickyIndex, stickyText])

  useLayoutEffect(() => {
    const schedule = () => {
      cancelAnimationFrame(overlapFrame.current)
      overlapFrame.current = requestAnimationFrame(syncStickyOverlap)
    }
    scheduleStickyOverlap.current = schedule
    schedule()
    return () => {
      cancelAnimationFrame(overlapFrame.current)
      scheduleStickyOverlap.current = () => {}
    }
  }, [syncStickyOverlap])

  useLayoutEffect(() => {
    if (stickyObscured) {
      wasStickyObscured.current = true
      setStickyReturning(false)
      return
    }
    // The return direction only changes when coming back from being hidden. First entry is
    // still cc-hang's usual bottom-to-top.
    if (wasStickyObscured.current) {
      wasStickyObscured.current = false
      setStickyReturning(true)
    }
  }, [stickyObscured])

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
  }, [totalSize, pending, working, bottomPad, scrollRef])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      /*
        The moment a person touches the conversation, "settling at the bottom" ends right there
        (#31). The same touch is what lets the follow effect read a drop as theirs — a wheel only
        when it turns upward, a pointer (the scrollbar) or a finger for as long as it is held;
        keys are watched on the window, above.
      */
      onWheel={(e) => {
        endLanding()
        if (e.deltaY !== 0) noteInput()
      }}
      onPointerDown={() => {
        endLanding()
        held.current = true
        noteInput()
      }}
      onTouchStart={() => {
        held.current = true
      }}
      onKeyDown={endLanding}
      /* min-h-0: even with overflow-y-auto set, this would stretch itself if it could not shrink */
      /*
       * invisible (visibility:hidden) is only for while it settles into position (see the
       * comment above #61). Measuring has to keep happening, so this hides only the picture,
       * not the layout.
       */
      className={`min-h-0 flex-1 overflow-y-auto px-4 pt-4 text-md leading-body ${
        bottomPeek ? 'pb-14' : 'pb-4'
      } ${settling ? 'invisible' : ''}`}
      /* The empty space the card will settle onto. Follows size, not state, so there is no
      transition or animation */
      style={bottomPad === undefined ? undefined : { paddingBottom: `${bottomPad}px` }}
      data-testid="chat-stream"
      data-settling={settling || undefined}
    >
      {/*
        Which question the turn being viewed answers — left as a single line so reading a long
        response never requires scrolling back up to check.
      */}
      {stickyText !== null && (
        /*
          A negative offset, not `top-0`.
          This scroll container has `py-4` around it, and sticky **cannot leave its own
          containing block (the parent's content box)** — so `top-0` sat 16px below the padding
          rather than at the ceiling (measured: a 16px gap). A negative offset gives that 16px
          back, reaching the actual ceiling. The padding itself is kept: it is the room the
          conversation gets to breathe in once scrolled all the way up.

          Why **10**, not 16: 6px is deliberate slack. Sticking it flush to the ceiling was
          tried twice — a 1px overlap, then a 3px overlap plus opacity. Trunk WebKit measured a
          0 gap, but the real WKWebView (an older system engine) always left a hairline gap in
          the end (found in dogfooding three times before the conclusion: an engine's
          compositing rounding cannot be beaten). If it cannot be flush, **it is deliberately
          set apart instead** — a 6px gap absorbs that hairline (±1px) into the design instead
          of reading as an error, and the banner reads as a floating card rather than a strip
          hanging off the edge (which is also why the button below gets the same rounded
          corners on all four sides and a complete border, like a message bubble).
        */
        <div
          className={`sticky -top-[10px] z-10 -mx-4 mb-1 flex justify-end px-4 ${
            stickyObscured ? 'pointer-events-none' : ''
          }`}
          data-testid="sticky-user"
        >
          {/*
            Gets **the same skin, position and width** as a message bubble. This row is an
            extension of the user message that scrolled off the top, and differing in even one
            of those reads as something else entirely.

            That is exactly what happened when the width was left full: a 75%-wide bubble
            anchored to the right suddenly became a strip stretching edge to edge, and it read
            not as something the person said but as **a toolbar floating below the header**
            (dogfooding: "it is not flush against the top"). Measured, it was already flush —
            0px from the scroll container's ceiling, at zoom levels 0.9, 1.0, 1.1, 1.15 and 1.2,
            all 0px. What made it look detached was shape, not position. So this is given the
            same right alignment and `max-w-[75%]` as a message bubble, with its width following
            the text length (w-fit).

            Being a **card** floating 6px off the ceiling is why it gets the same rounded
            corners on all four sides and a complete border as a message bubble (how the flush
            attempt was abandoned is in the -top comment above). It rises a few pixels from
            below and settles as it appears (cc-hang) — that motion is what says "this is
            floating here". (There was a translucent-plus-blur version — meant to show
            "covering", not "hiding" — but the conversation showing through it kept reading as
            "a gap against the header", so it was dropped.)

            Clicking expands it — for reading a question too long for one line again, without
            scrolling back up. A very long question has its height clipped and scrolls inside
            instead of covering the whole screen.
          */}
          <div
            ref={stickyRef}
            className={`relative w-fit max-w-[75%] ${
              stickyObscured ? 'cc-hang-out-up pointer-events-none' : stickyReturning ? 'cc-hang-in-down' : 'cc-hang'
            }`}
            data-obscured={stickyObscured ? 'true' : undefined}
          >
            {/*
              **Opaque** (the conclusion after the third round of dogfooding feedback on this).
              Translucent-plus-blur was meant to say "covering, not hiding", but even with a
              measured geometric gap of zero (header bottom equals scroll ceiling, measured in
              WebKit), the conversation showing through it kept reading as "a gap against the
              header" — WKWebView's backdrop-filter on a sticky element inside a scroll
              container is unreliable, and the content behind it sometimes showed through with
              no blur at all. Three repeated misreadings outweigh the nuance this was meant to
              convey. The color replaces the composited color that surface-hover/55 used to produce
              over surface-floor with a surface-raised token instead — the visible brightness is unchanged.
            */}
            <button
              type="button"
              onClick={() => setStickyOpen((v) => !v)}
              aria-expanded={stickyOpen}
              className="w-full cursor-pointer truncate rounded-lg rounded-br-md border border-ink-faint/40 bg-surface-hover px-3 py-2 text-left text-md text-ink shadow-(--shadow-sticky)"
            >
              {stickyText}
            </button>
            {/*
              Expanding is a **cover**, not flow. If the banner grew taller in the document
              flow, every coordinate in the virtual scroller below it would shift — instead, the
              collapsed single line holds its place, and the full text is overlaid on top of it.
              A very long question has its height clipped and scrolls inside.
            */}
            {stickyOpen && (
              <button
                type="button"
                onClick={() => setStickyOpen(false)}
                data-testid="sticky-user-expanded"
                /*
                  The same shape as the collapsed strip, but **less transparent here.** The
                  collapsed row's transparency is meant to show "covering, not hiding", but the
                  reason to expand it is to read it — the conversation showing through a long
                  question would immediately defeat that purpose.
                */
                className="absolute inset-x-0 top-0 z-10 max-h-60 cursor-pointer overflow-y-auto whitespace-pre-wrap break-words rounded-lg rounded-br-md border border-ink-faint/40 bg-surface-hover px-3 py-2 text-left text-md text-ink shadow-(--shadow-sticky)"
              >
                {stickyText}
              </button>
            )}
          </div>
        </div>
      )}

      <OlderSentinel sessionId={sessionId} scrollRef={scrollRef} />

      {/*
        No scroll anchoring on the rows. They move with `top` (below), which Chromium's scroll
        anchoring sees, while a transform it did not; the virtualizer already keeps the view in
        place when a row above changes size, and anchoring on top of it would move it twice.
      */}
      {/* `data-sized-rows`: how many row heights the scroller holds, read by the #392 scenario */}
      <div
        className="relative w-full [overflow-anchor:none]"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
        data-sized-rows={virtualizer.itemSizeCache.size}
      >
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            ref={virtualizer.measureElement}
            data-index={v.index}
            /*
              More margin is added at turn boundaries. If every row had the same spacing, my
              message and the model's answer would look like a single block, making it
              impossible to find where my turn started after a long response. There is generous
              space before my message (separating it from the previous turn) and only a little
              after it (grouping it with the answer that follows).
            */
            /*
              Since the banner takes up space in the flow and pushes the rest of the list down
              by its own height, the original message that was judged to have "fully passed"
              gets pushed back down below the banner, and the same text shows up twice. The
              original is hidden while the banner speaks for that message instead — this uses
              visibility, so its position and size stay the same and the virtual scroller's
              measurements are undisturbed.
            */
            className={`absolute left-0 w-full min-w-0 ${
              chat[v.index]?.kind === 'user' ? 'pb-4 pt-6' : 'pb-3'
            } ${v.index === stickyIndex && stickyText !== null ? 'invisible' : ''} ${
              chat[v.index]?.storedSeq === searchTarget?.seq ? 'rounded-md bg-surface-hover/70 ring-1 ring-ink-muted/70' : ''
            }`}
            data-search-hit={chat[v.index]?.storedSeq === searchTarget?.seq ? 'true' : undefined}
            /*
              Placed with `top`, not `transform` (#364). A transform makes every row a stacking
              context, and once a code block in one row scrolls sideways (a composited scroller
              of its own), WebKit composited nearly every later row for overlap: six idle grid
              panels had 119 layers, 61 with `top`, and ~22 MB more backing store, kept for as long
              as anything repaints (docs/spikes/2026-10-memory-heavy-store.md §10). Rows only move when
              a size is measured, so `top` costs one positioned layout then, nothing on scroll.
            */
            style={{ top: v.start }}
          >
            <ChatRow item={chat[v.index]!} projectRoot={projectRoot} projectId={projectId} sessionId={sessionId} leaving={isLeaving(virtualizer.range, v.index)} />
          </div>
        ))}
      </div>

      {pending && (
        <ApprovalCard sessionId={sessionId} requestId={pending.requestId} detail={pending.detail} />
      )}

      {/* Several question cards can stack up — rendering only one leaves the rest with no way
      to be answered */}
      {questions.map((q) => (
        <QuestionCard
          key={q.requestId}
          sessionId={sessionId}
          requestId={q.requestId}
          questions={q.questions}
        />
      ))}

      {working && <ActivityRow sessionId={sessionId} activity={activity} />}
    </div>
  )
}

/** The number of rows the conversation list pre-renders off screen (on both sides) */
const CHAT_OVERSCAN = 12

/**
 * Whether this row is outside its natural range (the visible rows plus the pre-rendered ones) —
 * only a row held onto because it has an app view is ever rendered like this. That view sends
 * teardown and collapses (M4 B-1, see rangeExtractor above).
 */
function isLeaving(range: { startIndex: number; endIndex: number } | null, index: number): boolean {
  if (!range) return false
  return index < range.startIndex - CHAT_OVERSCAN || index > range.endIndex + CHAT_OVERSCAN
}
