import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatItem } from '../../../store/store.js'

/*
 * The banner that pins the person's latest message once it scrolls off the top (#428): which
 * message that is, when the next one comes in under it, and the banner itself. ChatStream reads
 * `stickyIndex` and `stickyText` to hide the original row; its scroll handler calls `syncSticky`.
 */

export function useStickyUser({
  scrollRef,
  chat,
  virtualizer,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
}) {
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

  return {
    stickyIndex,
    stickyText,
    syncSticky,
    scheduleStickyOverlap,
    stickyRef,
    stickyOpen,
    setStickyOpen,
    stickyObscured,
    stickyReturning,
  }
}

export type StickyUserState = ReturnType<typeof useStickyUser>

export function StickyUser({ sticky }: { sticky: StickyUserState }) {
  const { stickyText, stickyRef, stickyOpen, setStickyOpen, stickyObscured, stickyReturning } = sticky
  if (stickyText === null) return null
  return (
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
          data-mine-bubble
          className="w-full cursor-pointer truncate rounded-bubble border border-ink-faint/40 bg-surface-hover px-3 py-2 text-left text-md text-ink shadow-(--shadow-sticky)"
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
            data-mine-bubble
            className="absolute inset-x-0 top-0 z-10 max-h-60 cursor-pointer overflow-y-auto whitespace-pre-wrap break-words rounded-bubble border border-ink-faint/40 bg-surface-hover px-3 py-2 text-left text-md text-ink shadow-(--shadow-sticky)"
          >
            {stickyText}
          </button>
        )}
      </div>
    </div>
  )
}
