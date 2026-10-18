import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { SessionSummary } from '@cc/core'
import { inlineFrameShown, useStore, type ChatItem } from '../../../store/store.js'
import { ChatSkeleton } from '../../../components/Skeleton.jsx'
import { ApprovalCard } from '../../approval/ApprovalCard.jsx'
import { QuestionCard } from '../../approval/QuestionCard.jsx'
import { ChatRow } from '../chat-rows/ChatRow.jsx'
import { ActivityRow } from './ActivityRow.jsx'
import { OlderSentinel } from './OlderSentinel.jsx'
import { StickyUser, useStickyUser } from './StickyUser.jsx'
import { useChatScroll } from './useChatScroll.js'
import { forgetUnlistedSizes, rowKeys, writeScroll } from '../scroll.js'

/*
 * A session's conversation as a virtual list (#428): the rows, the pinned banner for the turn
 * being read, the cards still waiting on the person, and the activity row at the end.
 */

/** How long a conversation's skeleton waits for its history before the pane is left empty */
const SKELETON_GIVE_UP_MS = 10_000

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
   * A conversation that has messages but none read yet (switched to, or the app just opened) shows the shape of one
   * while its history arrives, instead of an empty pane. A read that keeps failing gives up after a while: the
   * empty pane is then the truth (nothing could be read), and a skeleton left forever would say otherwise.
   */
  const reading = useStore(
    (s) => chat.length === 0 && !s.history[sessionId] && (s.sessions[sessionId]?.lastSeq ?? 0) > 0,
  )
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    setGaveUp(false)
    if (!reading) return
    const t = setTimeout(() => setGaveUp(true), SKELETON_GIVE_UP_MS)
    return () => clearTimeout(t)
  }, [reading, sessionId])
  /*
   * "Was I at the bottom" is the session's fact, not this component's (issue #31).
   *
   * It stays a ref here because the follow logic reads it from a scroll handler and from
   * effects — re-rendering on it would mean re-rendering on every scroll — but the ref is
   * only a copy. The session holds the original, so a panel that is torn down and built
   * again does not get to decide for itself where the person was.
   */
  const stickToBottom = useRef(true)
  const searchTarget = useStore((s) => s.searchTargets[sessionId] ?? null)

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
   * The banner is asked first because the scroll handler moves it. Neither hook's effects read
   * what the other's write, so their order between the two does not matter (#428).
   */
  const sticky = useStickyUser({ scrollRef, chat, virtualizer })
  const { stickyIndex, stickyText } = sticky
  const { onScroll, endLanding, noteInput, held, settling } = useChatScroll({
    sessionId,
    scrollRef,
    chat,
    virtualizer,
    stickToBottom,
    searchTarget,
    syncSticky: sticky.syncSticky,
    scheduleStickyOverlap: sticky.scheduleStickyOverlap,
    pending,
    working,
    bottomPad,
  })

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      /*
        The moment a person touches the conversation, "settling at the bottom" ends right there
        (#31). The same touch is what lets the follow effect read a drop as theirs — a wheel only
        when it turns upward, a pointer (the scrollbar) or a finger for as long as it is held;
        keys are watched on the window, in useChatScroll.ts.
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
       * `settling` comment in useChatScroll.ts, #61). Measuring has to keep happening, so this hides only the picture,
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
      <StickyUser sticky={sticky} />

      <OlderSentinel sessionId={sessionId} scrollRef={scrollRef} />
      {reading && !gaveUp && <ChatSkeleton />}

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
              chat[v.index]?.kind === 'user' ? 'pb-4 pt-6' : bubbleOf(chat, v.index) ? '' : 'pb-3'
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
            <AnswerBubble part={bubbleOf(chat, v.index)}>
              <ChatRow item={chat[v.index]!} projectRoot={projectRoot} projectId={projectId} sessionId={sessionId} leaving={isLeaving(virtualizer.range, v.index)} />
            </AnswerBubble>
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

/**
 * Where a row stands in the agent's answer bubble (owner, 2026-10-18): everything the agent did between two of the
 * person's messages (text, reasoning, tool calls, images, approvals) is one bubble, like the person's own message
 * on the right, so a turn reads as one reply and not as loose rows. Markers (compaction, handoff, an error line)
 * belong to the conversation, not to the answer, so they stand outside and split it.
 *
 * The list is virtual, so the bubble is drawn in pieces, one per row: the first rounds the top, the last the
 * bottom, the ones between carry only the sides. No gap between rows inside a bubble: the spacing is the piece's
 * own padding, so the background runs on. Full width, with a rounder corner than the theme's scale has (14px).
 */
type BubblePart = 'solo' | 'first' | 'mid' | 'last'

function inBubble(item: ChatItem | undefined): boolean {
  return item !== undefined && item.kind !== 'user' && item.kind !== 'mark'
}

function bubbleOf(chat: readonly ChatItem[], i: number): BubblePart | null {
  if (!inBubble(chat[i])) return null
  const before = inBubble(chat[i - 1])
  const after = inBubble(chat[i + 1])
  return before ? (after ? 'mid' : 'last') : after ? 'first' : 'solo'
}

const BUBBLE_EDGE: Record<BubblePart, string> = {
  solo: 'rounded-[14px] border pt-3 pb-3',
  first: 'rounded-t-[14px] border border-b-0 pt-3 pb-3',
  mid: 'border-x pb-3',
  last: 'rounded-b-[14px] border border-t-0 pb-3',
}

function AnswerBubble({ part, children }: { part: BubblePart | null; children: ReactNode }) {
  if (!part) return <>{children}</>
  return (
    <div className={`min-w-0 border-line bg-surface-raised px-4 ${BUBBLE_EDGE[part]}`} data-bubble={part}>
      {children}
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
