import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { isInTurn, shouldMarkRead } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { Kbd, canContinue } from '../../components/primitives.jsx'
import { useSessionAway } from '../../store/selectors.js'
import { lazyComponent } from '../../components/lazy.jsx'
import { isFileDrag } from '../files/dragPath.js'
import { APP_LINK_DROP_EVENT, type AppLinkDrop } from '../app-frame/dragRelay.js'
import { isOutsideLink } from './dragLink.js'
import { ChatStream } from './chat-stream/ChatStream.jsx'
import { SessionStart } from './SessionStart.jsx'
import { Composer, type ComposerDrop } from './Composer.jsx'
import { SessionHeader } from './SessionHeader.jsx'
import { AwayNote, DormantNote, InterruptedNote } from './SessionNotes.jsx'
import { EMPTY_CHAT } from './empty.js'

/**
 * The detection zone (in px, measured up from the bottom of the pane) that makes a collapsed
 * composer rise up. The exposed card's header (14px) plus 40px of slack for the hand to aim at
 * — it does not rise while the hand is in the middle of the conversation.
 */
const COMPOSER_REACH = 54

/** The run-command window brings xterm, so it loads when first opened (components/lazy.tsx) */
const CommandRunnerOverlay = lazyComponent(() =>
  import('./CommandRunner.jsx').then((m) => m.CommandRunnerOverlay),
)

/**
 * The focus view — one chosen session at full width.
 *
 * The session screen itself is drawn by SessionPane. Grid cells use **the same component**: a
 * copy would leave the other side holding a stale value whenever a model or permission changed
 * on one side. This only decides what to show and hands off the actual rendering.
 */
export function SessionView() {
  const session = useFocusedSession()
  // Until the host's first lists arrive nothing is said here (owner, 2026-10-18): the session being restored may be
  // about to open, so "Select a project or session" would flash first. Once known, the line fades in.
  const listed = useStore((s) => s.connection === 'connected' || Object.keys(s.sessions).length > 0)

  if (!session) {
    if (!listed) return <div className="flex-1" data-testid="empty-focus-waiting" />
    // With a project picked and no session, App shows the project screen (ProjectView, #203) instead of this
    return (
      <div
        className="cc-fade flex flex-1 flex-col items-center justify-center gap-3 text-center"
        data-testid="empty-focus"
      >
        <p className="text-md text-ink-muted">Select a project or session</p>
        <p className="text-xs text-ink-faint">
          <Kbd mod /> <Kbd>I</Kbd> shows everything waiting on you
        </p>
      </div>
    )
  }

  return <SessionPane sessionId={session.id} />
}

/**
 * A single session's screen — header, conversation, composer.
 *
 * **Both the focus view and the grid use this.** That is why changing the model in a grid cell
 * is immediately reflected in the sidebar and the focus view: they all read a single store
 * instead of each holding a copy of the state.
 *
 * An unsent draft is held by the **session**, not by this component. That is why it survives
 * switching screens but does not follow when switching sessions — back when the component held
 * it, both of those behaved the opposite way.
 */
export function SessionPane({
  sessionId,
  headerExtra,
  headerDrag,
  fold = false,
}: {
  sessionId: string
  /**
   * A button added to the right of the header (the grid's "dismiss").
   *
   * Taken as a slot because the grid once tried laying its own button over the cell with
   * absolute positioning, and its size and vertical alignment ended up out of step with the
   * header's own buttons. Putting it in the same row means alignment never needs fixing — it
   * cannot drift apart in the first place.
   */
  headerExtra?: ReactNode
  /**
   * Whether to keep the composer collapsed (the grid, requested by a user on 2026-09-10).
   *
   * This came from a two-row grid leaving too little room to read — of a 370px cell, the input
   * area took up 95px, and only 22px of that was the actual text field. Collapsed, **only the
   * rounded card's top edge** remains, and it rises above the conversation once a hand comes
   * near the bottom. It overlays rather than pushing, so the row being read does not move.
   */
  fold?: boolean
  /**
   * Uses the header as **the handle that moves the pane** (the grid).
   *
   * When supplied, this header is no longer the handle that closes the window. That is because
   * in the focus view the header is the title bar, but in the grid it is not — the same
   * component's header means something different depending on where it sits. This does not
   * leave the component to guess at that difference on its own.
   */
  headerDrag?: (e: DragEvent<HTMLElement>) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const chat = useStore((s) => s.chat[sessionId] ?? EMPTY_CHAT)
  /*
   * The directory a path in this conversation would be relative to (#39).
   *
   * It is read from this session rather than from whatever is focused because a grid cell
   * renders this same component for a session that is not the focused one — asking the
   * focused session would resolve one pane's paths against another pane's project. The
   * orchestrator has no project at all and so gets null, which is what stops its messages
   * from linking anywhere (see `parseFileRef`).
   */
  const projectRoot = useStore((s) => {
    const pid = s.sessions[sessionId]?.projectId
    return (pid && s.projects[pid]?.path) || null
  })
  const markRead = useStore((s) => s.markRead)

  /*
   * Whether the Run menu is open — held here rather than inside it (issue #44).
   *
   * In the grid this header is the handle that moves the panel, and `draggable` reaches
   * everything inside it: press on a menu row, move a few pixels, and the browser drags the
   * panel instead of letting the click land. The header already learned the neighbouring
   * half of this lesson — a `draggable` ancestor is why the whole cell stopped being one.
   */
  const [runOpen, setRunOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * Whether the collapsed composer is raised (only meaningful when `fold` is set).
   *
   * Four triggers are **OR'd together**: a hand near the bottom (hover), **a hand over the
   * raised card**, focus in the input field, or that row's menu (model, permissions) being
   * open. Even after the mouse leaves, it stays up while focus or the menu is still alive — the
   * ground must not disappear while someone is in the middle of typing.
   *
   * Why hover over the card needs its own trigger (reported by a user on 2026-09-10): the strip
   * (COMPOSER_REACH, below) is what **raises** the composer while it is collapsed. A raised card
   * extends above that strip, so the moment a hand moved up to click the input field, it left
   * the strip and the card dropped back down — **it could not be clicked.**
   */
  const [nearComposer, setNearComposer] = useState(false)
  const [overComposer, setOverComposer] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [composerMenu, setComposerMenu] = useState(false)
  /**
   * Whether something dropped on the pane became an attachment, **and is therefore raised**
   * (#116).
   *
   * A collapsed composer sits off-screen. If a file lands there, there is no room to see it get
   * attached, and it becomes indistinguishable from nothing happening — hence a fifth trigger
   * alongside the other four. It drops back down when the hand leaves the pane entirely (see
   * onMouseLeave below), the same rule as hover.
   */
  const [droppedIn, setDroppedIn] = useState(false)
  /**
   * Whether something droppable is hovering over the pane — the same signal as the composer's
   * border, but sized to the whole pane
   */
  const [dragOver, setDragOver] = useState(false)
  const composerDrop = useRef<ComposerDrop>(null)
  /*
   * An item dragged out of an app view lands here as an event, not a drop (#308): the page never
   * hears a drag from another origin, so the view's relay reports where it ended and the frame
   * hands the link to the element under that point (app-frame/dragRelay.ts). Anywhere on the pane
   * counts, as for a file (#116): the composer is usually folded away.
   */
  const paneRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const onAppDrop = (e: Event) => {
      const drop = (e as CustomEvent<AppLinkDrop>).detail
      e.stopPropagation()
      if (!composerDrop.current?.acceptAppLink(drop)) return
      drop.landed = true
      setDroppedIn(true)
    }
    pane.addEventListener(APP_LINK_DROP_EVENT, onAppDrop)
    return () => pane.removeEventListener(APP_LINK_DROP_EVENT, onAppDrop)
  }, [])
  const composerUp = !fold || nearComposer || overComposer || composerFocused || composerMenu || droppedIn

  /*
   * The height the raised card takes up — **found by measuring it** (reported by a user on
   * 2026-09-13).
   *
   * It cannot be a constant: an attachment adds a row, and the input field grows up to five
   * lines. This value becomes the margin below the conversation, so any mismatch leaves that
   * much of the last line hidden under the card.
   */
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerH, setComposerH] = useState(0)
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!fold || !el) return
    const measure = () => setComposerH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fold])

  const loadHistory = useStore((s) => s.loadHistory)
  /*
   * "Loaded" means having a history cursor (#79). While this was judged by whether there were
   * conversation rows, a session whose rows came from an event arriving first, and that was
   * only ever seen in a grid cell, had never actually loaded history — with no cursor, "Load
   * earlier messages" never appeared either.
   */
  const loaded = useStore((s) => !!s.history[sessionId])
  useEffect(() => {
    if (!loaded) void loadHistory(sessionId)
  }, [sessionId, loaded, loadHistory])

  /*
   * Marking read: reaching the latest point by scroll, or 3 seconds of focus (the judgment
   * itself lives in core).
   *
   * **Only counts while the app is in front** (#161). This used to always pass `focused: true`,
   * so a turn that finished behind another window still counted as read 3 seconds later — the
   * person never saw the result, yet the unread mark cleared and it dropped down the inbox
   * order too. "Seen" has to match the criterion used by `turn_complete`'s notification and by
   * `Notices` (`appFocused` and actually on screen). Coming back to the app flips `appFocused`
   * and restarts the 3-second count.
   */
  const appFocused = useStore((s) => s.appFocused)
  useEffect(() => {
    if (!session || !appFocused) return
    const t = setTimeout(() => {
      const el = scrollRef.current
      const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 40 : true
      if (shouldMarkRead({ focused: useStore.getState().appFocused, atBottom, focusedForMs: 3000 }))
        void markRead(session.id)
    }, 3000)
    return () => clearTimeout(t)
  }, [session, chat.length, markRead, appFocused])

  /*
   * An app's agent session on screen is the person's (#378): said the moment it is shown in front, not after the
   * 3 seconds above: a short run ends, and its session is deleted, inside them
   */
  const markOpened = useStore((s) => s.markOpened)
  const sessionShownId = session?.id
  const shownAppSession = !!session?.appId
  useEffect(() => {
    if (sessionShownId && shownAppSession && appFocused) void markOpened(sessionShownId)
  }, [sessionShownId, shownAppSession, appFocused, markOpened])

  // On a linked machine that is away (#82): dimmed, and nothing here tries to wake it
  const away = useSessionAway(sessionId)

  // Avoid rendering even at the moment the session disappears (deleted, archived)
  if (!session) return null

  // A brand-new session (nothing said, nothing stored) offers the other tool, and the past conversations to resume
  const starting =
    !!session &&
    session.kind === 'worker' &&
    !!session.projectId &&
    !session.appId &&
    session.lastSeq === 0 &&
    chat.length === 0

  return (
    /*
      min-h-0 is not optional.
      A flex child's min-height defaults to auto, so it **cannot shrink smaller than its
      content.** That meant a long conversation stretched this pane and pushed the composer
      off-screen entirely (this showed up immediately in the grid, where cell height is
      fixed — the composer just was not visible at all).
    */
    <section
      /*
       * With `fold`, this is **clip, not hidden.**
       *
       * The collapsed composer sits below the pane — that is scrollable overflow.
       * `overflow:hidden` only clips the picture; the box is still a scroll container, so the
       * moment the browser gives focus to the off-screen input field, it tries to **scroll the
       * whole pane up** to show it (measured: the pane scrolled 85px, the header disappeared
       * upward, and the button that had just been pressed never received its mouseup, so the
       * click vanished entirely). `clip` never creates a scroll container, so there is nowhere
       * for it to scroll up to in the first place.
       */
      ref={paneRef}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-floor ${fold ? 'overflow-clip' : ''}`}
      data-testid="session-view"
      /*
       * The composer rises when a hand comes near the bottom. Detection uses **coordinates, not
       * a fake element** — laying down a transparent detection plate would take that much area
       * away from selecting conversation text or clicking links. The zone reaches 40px above
       * the strip (14px): easy to aim for, while not triggering while passing through the
       * middle of the conversation.
       */
      onMouseMove={
        fold
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setNearComposer(e.clientY > r.bottom - COMPOSER_REACH)
            }
          : undefined
      }
      onMouseLeave={
        fold
          ? () => {
              setNearComposer(false)
              setDroppedIn(false)
            }
          : undefined
      }
      /*
       * The whole pane is a drop target (#116) — not just the composer.
       *
       * Since the composer is collapsed by default (the store's foldComposer), the only place
       * that could actually accept a drop was usually off-screen. Someone carrying a file over
       * had nothing to aim at.
       *
       * Handling it here fixes all three screens at once: the focus view, a grid cell, and the
       * orchestrator are all this same component. In the grid it also means it attaches to
       * **the session of the cell it was dropped on** — not the focused session. Each cell
       * calls its own composer for the same reason.
       */
      onDragOver={(e) => {
        // Reordering (sessions, projects) has its own owner for that spot — this passes it
        // through untouched. A link from outside the window is taken like a file (#308)
        if (!isFileDrag(e.dataTransfer.types) && !isOutsideLink(e.dataTransfer.types)) return
        /*
         * If it is over the composer, the highlight belongs to it (the composer lights up its
         * border in ink-muted). If both light up at once, it says how many places would accept the
         * drop instead of where it would actually land.
         *
         * Turning it off happens here too: moving from the pane's background onto the composer
         * is not leaving the pane, so the dragleave below never fires for it.
         *
         * Why this is not judged with `defaultPrevented` — the window's floor guard (App.tsx)
         * has already blocked every drag during the capture phase, so by the time this runs
         * that value is always true. What needs asking is not "was it blocked" but "whose spot
         * is this".
         */
        if (composerRef.current?.contains(e.target as Node)) {
          setDragOver(false)
          return
        }
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        // A leave event also fires when moving into a child, so this only reacts to actually leaving
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!isFileDrag(e.dataTransfer.types) && !isOutsideLink(e.dataTransfer.types)) return
        setDragOver(false)
        // Something dropped exactly on the composer was already accepted by it — accepting it
        // again here would attach it twice
        if (composerRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        void composerDrop.current?.accept(e.dataTransfer).then((landed) => {
          if (landed) setDroppedIn(true)
        })
      }}
    >
      {/*
        A way of saying this can accept a drop (#116). **The same signal** as the composer
        lighting up its border in ink-muted, sized to the whole pane instead — no new color, and it
        never lights up for reordering at all. Placed below the composer (z-20) so it does not
        cover a raised card and its shadow.
      */}
      {dragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-10 rounded-lg border border-ink-muted"
          aria-hidden
          data-testid="pane-drop-target"
        />
      )}
      <SessionHeader
        session={session}
        projectRoot={projectRoot}
        runOpen={runOpen}
        setRunOpen={setRunOpen}
        headerExtra={headerExtra}
        headerDrag={headerDrag}
      />

      {starting && session?.projectId && (
        <SessionStart sessionId={sessionId} projectId={session.projectId} tool={session.tool} />
      )}
      <ChatStream
        yieldSpace={starting}
        bottomPeek={fold}
        /*
         * The card's full height is reserved **always** — it is never resized on rise
         * (reported by a user on 2026-09-13).
         *
         * At first this only reserved it while raised (24px at rest). Saving space looked like
         * the right call, but that meant the card rising **moved the conversation upward**. And
         * the gesture that raises it is lowering a hand toward the bottom — exactly the motion
         * of reaching for a question card's answer button. Reaching to press it made the button
         * run away upward.
         *
         * Not creating a moving target is worth more than the space it costs. So the empty
         * space is there from the start, and the card only settles onto it or drops away — the
         * conversation never moves by even one pixel.
         */
        bottomPad={fold ? composerH : undefined}
        scrollRef={scrollRef}
        chat={chat}
        pending={session.pendingApproval}
        questions={session.pendingQuestions}
        sessionId={session.id}
        projectRoot={projectRoot}
        working={session.state === 'working'}
        activity={session.activity}
      />

      {/*
        A session with no process (after the host restarts). The transcript still exists, so it
        can be read. This tells the person it can be continued before they say anything to it —
        better than reporting failure after they have already sent something (FR-10).
      */}
      {away ? (
        <AwayNote machine={session.machine ?? null} />
      ) : (
        !session.live && <DormantNote sessionId={session.id} />
      )}

      {/*
        The last turn stopped before it finished, and nobody here chose that (#698): the network, a quit, or the tool's
        own interrupt. Said above the composer with the one action that goes on, since the state alone (error, idle,
        waiting for input) looks the same as a turn that ended.
      */}
      {canContinue(session.interruption) && !isInTurn(session.state) && !away && (
        <InterruptedNote sessionId={session.id} interruption={session.interruption} />
      )}

      {/*
        Collapsed (requested by a user on 2026-09-10): a rounded card shows only its top edge
        from below, then rises. **Not explained in words** — the rounded corners themselves say
        this is a card that can rise.

        Still absolutely positioned (does not touch the conversation's layout height). But it
        **does not overlay** it: empty space the height of the card is always reserved below the
        conversation, and the card only settles onto that space or drops away (reported by a
        user on 2026-09-13). The original virtue was "overlay instead of pushing", but the cost
        of that virtue was not being able to read the last few lines — it hid exactly what a
        hand reaching down to read was reaching for. Pushing the content up on rise was not the
        answer either: the gesture that summons the card is the same gesture as reaching for a
        question card's answer button, so the button being reached for ran away.
      */}
      <div
        className={
          fold
            ? /*
               * The bottom corners are rounded too — at **the same radius** as the pane
               * (reported by a user on 2026-09-10). The pane is clipped with rounded-lg, and a
               * square card bottom gets cut by that curve into a sharp, broken-looking corner.
               * Drawing the same curve leaves nothing for it to be cut by. The curve it meets is
               * inside the pane's 1px border, so it is the pane's radius minus that pixel.
               */
              `absolute inset-x-0 bottom-0 z-20 rounded-t-lg rounded-b-[calc(var(--radius-lg)-1px)] border border-line bg-surface-floor px-1 pt-1 transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
                composerUp
                  ? /*
                     * The shadow's job is **to separate the card from the text it covers.**
                     * It covers the most while raised, so it is cast further — the darkness is
                     * kept the same as when collapsed (measured: both bottom out at 12, over
                     * the pane's floor colour then, #1d1d1d; it is #141414 since #362 and #0f0f0f since #725), only the
                     * spread distance is increased.
                     * 25px here, 18px when collapsed.
                     */
                    'translate-y-0 shadow-(--shadow-dock-raised)'
                  : /*
                     * At rest, **only the top edge remains** (reported by a user on 2026-09-11:
                     * "the input is not visible").
                     *
                     * This used to show 26px. Measured, that height also revealed the top 9px
                     * of the input field itself — a resting card read as "an empty input field".
                     * The surface with nothing happening on it was saying the most on screen.
                     *
                     * The 16px shown now is **the entire margin from the card's top edge to the
                     * input field**, and exactly that much (specified by a user on 2026-09-11):
                     * the card's pt-1 (4px) plus the form's py-3 (12px). The very next line is
                     * the input field's top border, so this value is **the maximum that can be
                     * shown while still hiding the input field** — raising it by even 1px brings
                     * that border above the threshold (measured). If either margin changes,
                     * this number has to change along with it.
                     *
                     * This height is also why bg-surface-raised could be restored on the input field —
                     * the bright strip that used to peek out and look like a hole in the pane's
                     * floor is gone now.
                     *
                     * This does not make the height hard to reach — what triggers the rise is
                     * not the card but the pane's 54px bottom strip (COMPOSER_REACH), so even as
                     * the visible sliver gets thinner, a hand summons the card from the same
                     * spot as before.
                     *
                     * The background is still the same color as the pane's floor, and the
                     * card's border is darker too (line is darker than the pane's line-strong). It
                     * is shape, not brightness, that says the card is there. A shadow is still
                     * cast here too (reported by a user on 2026-09-11). Cast short, but not
                     * faint — with only a 16px sliver showing, brightness alone cannot say it,
                     * so this shadow alone is what says the card is **resting on** the pane.
                     *
                     * The darkness was tuned with a ruler, not by eye: the pane's floor was
                     * #1d1d1d then (#141414 since #362, #0f0f0f since #725, not re-tuned), so on screen, black barely moves at all — a ruler with fewer than
                     * ten marks on it. Measured in pixels, over a floor of 18, this shadow's
                     * darkest line comes out to **12**. That value came from five rounds of
                     * measuring: 12 → 6 (too dark) → 9 ("halfway") → 10 ("just a touch
                     * lighter") → 12 ("bring the darkness back down", specified by a user on
                     * 2026-09-12). Each notch was one round of feedback, and after it got
                     * longer, it landed back on the original value — the problem was never the
                     * darkness, it just was not noticeable because it was **too short**.
                     *
                     * Darkness and **length move independently**. "Longer, same darkness"
                     * (specified by a user on 2026-09-12) can only hold if increasing the blur
                     * is paired with lowering the alpha — increasing blur alone spreads the same
                     * ink thinner and lightens the darkest point along with it, and raising
                     * alpha alone darkens it. Length was narrowed down the same way, by
                     * measuring: 13px (too short) → 25px (too long) → **18px** (the midpoint,
                     * specified by a user on 2026-09-12). While raised: 18 → 32 → 25px. The
                     * darkest point was held fixed at 12 while only the length moved — reducing
                     * blur concentrates the same ink into a narrower band and darkens that
                     * point, so the alpha is lowered every time to bring it back to 12.
                     */
                    'translate-y-[calc(100%_-_16px)] shadow-(--shadow-dock)'
              }`
            : undefined
        }
        ref={composerRef}
        data-testid="composer-shell"
        data-up={fold ? composerUp || undefined : undefined}
        onMouseEnter={fold ? () => setOverComposer(true) : undefined}
        onMouseLeave={fold ? () => setOverComposer(false) : undefined}
        onFocusCapture={fold ? () => setComposerFocused(true) : undefined}
        onBlurCapture={
          fold
            ? (e) => {
                // Focus moving within the same box has not actually left it (attach button ↔ input field)
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setComposerFocused(false)
              }
            : undefined
        }
      >
        <Composer
          sessionId={session.id}
          framed={!fold}
          onMenuOpenChange={fold ? setComposerMenu : undefined}
          dropRef={composerDrop}
        />
      </div>

      {/* The frequently used commands window (#60) — opens inside the pane. In a grid cell,
      the window is that cell's size */}
      {runOpen && session.projectId && (
        <CommandRunnerOverlay projectId={session.projectId} onClose={() => setRunOpen(false)} />
      )}
    </section>
  )
}
