import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatItem } from '../../../store/store.js'
import { isRelayed, mineBubbleAttrs, mineBubbleLook } from '../chat-rows/bubbleLook.js'
import { FromArrowIcon } from '../../../components/icons.jsx'

/*
 * The banner pinning the person's latest message once it scrolls off the top (#428, docs/design-system.md §7).
 * ChatStream hides the original row by `stickyIndex` and `stickyCovers`.
 */

/** design-system §9, the 150-200 ms layers */
export const STICKY_FOLD_MS = 180

export function useStickyUser({
  scrollRef,
  chat,
  virtualizer,
  folded = false,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** The pane folded its composer: the copy leaves upward */
  folded?: boolean
}) {
  /*
   * The person's latest message above the view. Not `position: sticky` on the row: virtual rows are
   * absolutely placed. From `measurementsCache`, as a message far off screen is not rendered.
   */
  const [stickyIndex, setStickyIndex] = useState<number | null>(null)
  const pinnedIndex = useRef<number | null>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  // Plugged in after the render, as the scroll handler runs before the card does
  const scheduleStickyOverlap = useRef<() => void>(() => {})

  const syncSticky = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    let found: number | null = null
    for (const m of virtualizer.measurementsCache) {
      // By the row's end: a half-visible row would show twice
      if (m.end > top) break
      if (chat[m.index]?.kind === 'user') found = m.index
    }
    /*
     * Not set again when the same (#2059): a socket's burst in one task commits again and again with an
     * effect's update still waiting, and past 50 such nested updates React throws from the next store update.
     */
    if (found === pinnedIndex.current) return
    pinnedIndex.current = found
    setStickyIndex(found)
  }, [chat, virtualizer, scrollRef])

  useEffect(syncSticky, [syncSticky, chat.length])

  const pinned = stickyIndex !== null ? chat[stickyIndex] : undefined
  // A relayed message is pinned under its source (FR-11); an image alone shows its name
  const pinnedText =
    pinned?.kind === 'user' ? pinned.text || (pinned.attachments?.map((a) => a.name).join(', ') ?? '') : null
  const stickyRelayed = pinned?.kind === 'user' && isRelayed(pinned)
  const stickyText = pinned?.kind === 'user' && pinnedText ? pinnedText : null
  const stickySource =
    pinned?.kind === 'user'
      ? pinned.from
        ? pinned.from.name
        : pinned.fromApp
          ? `${pinned.fromApp.name} app`
          : pinned.fromScript
            ? `script ${pinned.fromScript.credential}`
            : null
      : null

  const [stickyOpen, setStickyOpen] = useState(false)
  const [stickyObscured, setStickyObscured] = useState(false)
  /** Back from under the next message: enters top-down */
  const [stickyReturning, setStickyReturning] = useState(false)
  const wasStickyObscured = useRef(false)
  useEffect(() => {
    setStickyOpen(false)
    setStickyObscured(false)
    setStickyReturning(false)
    wasStickyObscured.current = false
  }, [stickyIndex])

  // Folded, the original row shows instead; they swap at the end of the exit and the start of the return, never both drawn
  const [stickyGone, setStickyGone] = useState(folded)
  useEffect(() => {
    if (!folded) {
      setStickyGone(false)
      return
    }
    const t = setTimeout(() => {
      setStickyGone(true)
      // Out of sight, so the expanded card faded with the copy rather than snapping away
      setStickyOpen(false)
    }, STICKY_FOLD_MS)
    return () => clearTimeout(t)
  }, [folded])
  const stickyCovers = stickyText !== null && (!folded || !stickyGone)

  /*
   * The banner steps aside when the next user message meets it, judged from the rendered rectangles
   * (the list's measurements miss the card's wrapping and open state), on the next frame, after the
   * render of the scroll's `stickyIndex`: at the event the old banner is still in the DOM.
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
    // 4px early: one frame of touching edges reads as text under the card
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

  // Checked again where the copy rests, once the fold's slide has ended
  useEffect(() => {
    const t = setTimeout(() => scheduleStickyOverlap.current(), STICKY_FOLD_MS + 20)
    return () => clearTimeout(t)
  }, [folded])

  useLayoutEffect(() => {
    if (stickyObscured) {
      wasStickyObscured.current = true
      setStickyReturning(false)
      return
    }
    if (wasStickyObscured.current) {
      wasStickyObscured.current = false
      setStickyReturning(true)
    }
  }, [stickyObscured])

  return {
    stickyIndex,
    stickyText,
    stickySource,
    stickyRelayed,
    syncSticky,
    scheduleStickyOverlap,
    stickyRef,
    stickyOpen,
    setStickyOpen,
    stickyObscured,
    stickyReturning,
    stickyFolded: folded,
    stickyCovers,
  }
}

export type StickyUserState = ReturnType<typeof useStickyUser>

export function StickyUser({ sticky }: { sticky: StickyUserState }) {
  const { stickyText, stickySource, stickyRelayed, stickyRef, stickyOpen, setStickyOpen, stickyObscured, stickyReturning, stickyFolded } =
    sticky
  if (stickyText === null) return null
  const said =
    stickySource === null ? (
      stickyText
    ) : (
      <>
        {stickySource} <FromArrowIcon /> {stickyText}
      </>
    )
  return (
    /*
      -10px: sticky cannot leave the scroller's `py-4` content box, so `top-0` sat 16px low. Not
      -16: flush, trunk WebKit measures no gap but the real WKWebView (an older engine) leaves a
      hairline, so a 6px gap absorbs it and the banner reads as a floating card, rounded all round.
    */
    <div
      /*
        Folded: a transition on this wrapper, so it composes with the card's own steps aside
        (`cc-hang-out-up`, `cc-hang-in-down`). It keeps its place in the flow, or every virtual row
        would move; `inert` hands clicks to what lies under it through the exit.
      */
      className={`sticky -top-[10px] z-10 -mx-4 mb-1 flex justify-end px-4 transition-[translate,opacity] duration-[180ms] ease-out motion-reduce:transition-[opacity] ${
        stickyFolded ? '-translate-y-[calc(100%+12px)] opacity-0 motion-reduce:translate-y-0' : 'translate-y-0 opacity-100'
      } ${stickyObscured || stickyFolded ? 'pointer-events-none' : ''}`}
      inert={stickyFolded}
      data-folded={stickyFolded ? 'true' : undefined}
      data-testid="sticky-user"
    >
      {/*
        The bubble's skin, side and width (design-system §7): at full width it read as a toolbar
        under the header, detached even when flush (0px at zooms 0.9 to 1.2): shape, not position.
      */}
      <div
        ref={stickyRef}
        className={`relative w-fit max-w-[75%] ${
          stickyObscured ? 'cc-hang-out-up pointer-events-none' : stickyReturning ? 'cc-hang-in-down' : 'cc-hang'
        }`}
        data-obscured={stickyObscured ? 'true' : undefined}
      >
        {/*
          Opaque: WKWebView's backdrop-filter on a sticky element in a scroll container sometimes shows
          the content with no blur, which read as a gap against the header.
        */}
        <button
          type="button"
          onClick={() => setStickyOpen((v) => !v)}
          aria-expanded={stickyOpen}
          {...mineBubbleAttrs(stickyRelayed)}
          className={`w-full cursor-pointer truncate rounded-bubble border px-3 py-2 text-left text-md shadow-(--shadow-sticky) ${mineBubbleLook(stickyRelayed)}`}
        >
          {said}
        </button>
        {/* Expanded over the line, not in the flow,
            which would move every virtual row */}
        {stickyOpen && (
          <button
            type="button"
            onClick={() => setStickyOpen(false)}
            data-testid="sticky-user-expanded"
            {...mineBubbleAttrs(stickyRelayed)}
            className={`absolute inset-x-0 top-0 z-10 max-h-60 cursor-pointer overflow-y-auto whitespace-pre-wrap break-words rounded-bubble border px-3 py-2 text-left text-md shadow-(--shadow-sticky) ${mineBubbleLook(stickyRelayed)}`}
          >
            {said}
          </button>
        )}
      </div>
    </div>
  )
}
