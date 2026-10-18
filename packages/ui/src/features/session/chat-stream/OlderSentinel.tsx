import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useStore } from '../../../store/store.js'

/**
 * The path back up into older, compacted conversation.
 *
 * Even when the tool compacts context, **our transcript is never folded** — every message
 * stays in storage. What got folded is the model's memory, not the person's record.
 *
 * Not a button — **scrolling up loads more on its own.** The act of scrolling up already means
 * "I want to see more", so there is no reason to make someone press a button on top of that.
 *
 * **The scroll position is corrected** when older content is prepended. Prepending content
 * pushes the row being viewed further down, and without correcting for that, the reading
 * position would be lost and have to be scrolled back up to again.
 */
export function OlderSentinel({
  sessionId,
  scrollRef,
}: {
  sessionId: string
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const info = useStore((s) => s.history[sessionId])
  const loadOlder = useStore((s) => s.loadOlder)
  const ref = useRef<HTMLDivElement>(null)
  const more = info?.more ?? false
  const loading = info?.loading ?? false

  useEffect(() => {
    const el = ref.current
    const scroller = scrollRef.current
    if (!el || !scroller || !more) return

    /*
     * One load per fire (re-entrancy guarded locally). loadOlder itself also respects
     * loading/more, so any extra call quietly does nothing.
     */
    let firing = false
    const fire = () => {
      if (firing || loading) return
      firing = true
      const before = scroller.scrollHeight
      void loadOlder(sessionId).then(() => {
        // Scrolls down by exactly the amount grown, to hold the reading position in place
        requestAnimationFrame(() => {
          const grew = scroller.scrollHeight - before
          if (grew > 0) scroller.scrollTop += grew
          firing = false
        })
      })
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fire()
      },
      // Fills in a little before the top is actually reached — so the stall is never visible
      { root: scroller, rootMargin: '200px 0px 0px 0px' },
    )
    io.observe(el)
    /*
     * This does not rely on IntersectionObserver alone (found in dogfooding on 2026-09-04:
     * scrolling up on a real WKWebView failed to load older content — every reproduction in
     * Chromium passed). Even in an environment where the observer never fires, the scroll
     * position does not lie — since it calls the same `fire`, there is no double-firing.
     */
    const onScroll = () => {
      if (scroller.scrollTop < 300) fire()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [sessionId, more, loading, loadOlder, scrollRef])

  if (!more) return null
  /*
   * Also loadable with a click (found in dogfooding on 2026-09-04: in the Mea session, on a
   * resource upload, scrolling up failed to load older content — every Chromium/mock
   * reproduction passed, which points to a difference in WKWebView's IntersectionObserver or
   * scroll anchoring). Whatever the reason the observer fails to fire, a hand-operated fallback
   * remains, and if that fails too, loadOlder's toast explains why — a silent wall is the worst
   * outcome.
   */
  return (
    <div ref={ref} className="flex justify-center py-2" data-testid="load-older">
      <button
        type="button"
        onClick={() => void loadOlder(sessionId)}
        disabled={loading}
        className="readout rounded-md border border-line px-2 py-0.5 text-2xs text-ink-faint transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
      >
        {loading ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
    </div>
  )
}
