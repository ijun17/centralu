import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, ReactNode, Ref, RefObject } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { shouldMarkRead, type SessionSummary } from '@cc/core'
import { launchesSubagent } from '@cc/protocol'
import {
  EMPTY_DRAFT,
  composerTarget,
  inlineFrameShown,
  messagesToChat,
  useStore,
  type ChatAttachment,
  type ChatItem,
  type Draft,
} from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { useShortcut } from '../../app/shortcut.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { QuestionCard } from '../approval/QuestionCard.jsx'
import { ChevronIcon, CloseIcon, CrownIcon, PlusIcon, RestartIcon, SendIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Kbd } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { Markdown } from './Markdown.jsx'
import { InlineViewSlot } from './InlineView.jsx'
import { RunMenu } from './RunMenu.jsx'
import { CommandRunnerOverlay } from './CommandRunner.jsx'
import { SessionSettings } from './SessionSettings.jsx'
import { AutocompleteMenu, useAutocomplete, type Suggestion } from './Autocomplete.jsx'
import { guiCommandFor } from './guiCommands.js'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'
import { onFirstVisualLine, onLastVisualLine } from './caret.js'
import { composingKey, isComposerSendKey } from './composerKeys.js'
import { appendPath, isFileDrag, isOsFileDrag, readDragPath } from '../files/dragPath.js'
import {
  anchorAt,
  decideFollow,
  isAtBottom,
  isScrollUpKey,
  MOVED_UP_SLACK,
  personIsScrolling,
  shouldFollowAgain,
  stickAfterScroll,
  writeScroll,
} from './scroll.js'

/** The maximum height the composer can grow to. Must match CSS's max-h-40 */
const COMPOSER_MAX_H = 160

/**
 * The detection zone (in px, measured up from the bottom of the pane) that makes a collapsed
 * composer rise up. The exposed card's header (14px) plus 40px of slack for the hand to aim at
 * — it does not rise while the hand is in the middle of the conversation.
 */
const COMPOSER_REACH = 54

/**
 * A handle that lets the composer take over handling a drop received from outside it (#116).
 *
 * What it returns is "did something actually go in" — if a file is too large or saving fails,
 * nothing goes in. Expanding a collapsed composer before that check would bring up an empty
 * field that looks as if something had happened.
 */
type ComposerDrop = { accept: (dt: DataTransfer) => Promise<boolean> }

/**
 * A selector that creates a new array every time destabilizes the zustand snapshot and causes
 * infinite re-renders
 */
const EMPTY_CHAT: ChatItem[] = []
const EMPTY_QUESTIONS: SessionSummary['pendingQuestions'] = []

/**
 * The number of frames spent settling at the bottom right after the conversation opens (#31).
 *
 * The virtual scroller stretches the total height over several frames as it measures rows.
 * Landing on the bottom has to be redone throughout that — doing it only once leaves it stuck
 * at the pre-measurement height. 30 frames is just a generous ceiling, and it stops immediately
 * the moment the person touches anything.
 */
const LANDING_FRAMES = 30

/**
 * The focus view — one chosen session at full width.
 *
 * The session screen itself is drawn by SessionPane. Grid cells use **the same component**: a
 * copy would leave the other side holding a stale value whenever a model or permission changed
 * on one side. This only decides what to show and hands off the actual rendering.
 */
export function SessionView() {
  const session = useFocusedSession()

  if (!session) {
    // With a project picked and no session, App shows the project screen (ProjectView, #203) instead of this
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 text-center"
        data-testid="empty-focus"
      >
        <p className="text-[13px] text-ash">Select a project or session</p>
        <p className="text-[11px] text-slate">
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
  const restart = useStore((s) => s.restartSession)
  // Whether the process is being swapped out (the same lock as wake/fork) — the basis for the
  // button spinning and locking
  const restarting = useStore((s) => !!s.resuming[sessionId])
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
      if (shouldMarkRead({ focused: useStore.getState().appFocused, atBottom, focusedForMs: 3000 })) void markRead(session.id)
    }, 3000)
    return () => clearTimeout(t)
  }, [session, chat.length, markRead, appFocused])

  // Avoid rendering even at the moment the session disappears (deleted, archived)
  if (!session) return null

  /*
   * The header's height is written as **an explicit height**, not padding (2026-09-13).
   *
   * The value is back to 40px — 32px and 36px were both tried and reverted. What changed is how
   * it is written: writing it as py-2 lets the height be dictated by the tallest thing inside it
   * (the tool button row at 23px), and the evidence panel header standing next to it had 24px
   * inside it, coming out to 41px — **a 1px mismatch.** Two rows standing side by side show a
   * doubled edge from even a 1px difference. With both at h-10, that gap never has a chance to
   * appear.
   */
  const HEADER = 'flex h-10 items-center gap-2.5 border-b border-edge px-4'
  const header = (
    <>
      {/*
        A status dot is already told by the sidebar's tool marker and the grid's
        while-responding border. A tiny dot is barely visible while saying the same thing a
        third time, so it is left out of the header. Only the orchestrator gets a crown to the
        left of its title, marking not status but a **role**.
      */}
      {session.kind === 'orchestrator' && (
        <span className="flex shrink-0 text-ash" data-testid="session-header-crown">
          <CrownIcon size={14} />
        </span>
      )}
      <h1 className="truncate text-[13px] font-medium text-chalk" data-testid="session-name">
        {session.name}
      </h1>

      {session.limit && (
        <span className="readout text-[11px] text-ash" data-testid="limit-badge">
          Limit {session.limit.usedPercent != null ? `${session.limit.usedPercent}%` : 'reached'}
          {session.limit.resumeAt
            ? ` · resets ${new Date(session.limit.resumeAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
            : ''}
        </span>
      )}

      {/*
        A goal that is set (2026-09-07 — Claude's /goal, Codex's thread/goal/*). What a session
        running a goal cares about is "when does this end", so this carries a factual summary
        (iteration count, status) rather than the full condition text, and leaves the full text
        and the reason it fell short to the hover. It disappears once cleared, including on
        success.
      */}
      {session.goal && (
        <span
          className="readout shrink-0 rounded border border-edge px-1.5 text-[10px] text-ash"
          data-testid="goal-badge"
          title={`${session.goal.objective}${session.goal.reason ? `\n\n${session.goal.reason}` : ''}`}
        >
          GOAL
          {session.goal.iterations != null ? ` · ${session.goal.iterations}` : ''}
          {session.goal.status !== 'active' ? ` · ${session.goal.status}` : ''}
        </span>
      )}

      {/*
        Stop is not placed here — it already sits next to "waiting for a response" at the
        bottom of the conversation. Having a button that does the same thing at each end of the
        screen would mean checking every time which one is which.
      */}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {/*
          The project's saved shell commands (issue #44). Before restart because it is the
          everyday one — restart is a repair.

          The orchestrator has no project, and with no project there is no directory to run
          in and no terminal to run it in. So it gets no button rather than an empty menu:
          an entry that could never have anything in it is a worse answer than no entry.
        */}
        {session.projectId && <RunMenu projectId={session.projectId} open={runOpen} onOpenChange={setRunOpen} />}
        {/* Creating a new session when the tool locks up would cut off context — this swaps
        only the process */}
        {/*
          **The icon spins and the button locks** while this is pressed.
          It takes a few seconds, and a quiet screen would invite a second press, which
          would kill the process that just started — the button meant to fix things would
          cause the failure. The lock lives in the store (resuming): whether it is still
          running belongs to the session, not to this component, even as the screen switches
          between the grid and the focus view.
        */}
        <IconButton
          label={restarting ? 'Restarting the agent…' : 'Restart agent (chat history is kept)'}
          onClick={() => void restart(session.id)}
          disabled={restarting}
          testId="restart-session"
          align="right"
        >
          <span
            className={restarting ? 'cc-spin block' : 'block'}
            data-testid={restarting ? 'restart-spinning' : undefined}
          >
            <RestartIcon />
          </span>
        </IconButton>
        {headerExtra}
      </span>
    </>
  )

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
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-void ${fold ? 'overflow-clip' : ''}`}
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
        // through untouched
        if (!isFileDrag(e.dataTransfer.types)) return
        /*
         * If it is over the composer, the highlight belongs to it (the composer lights up its
         * border in ash). If both light up at once, it says how many places would accept the
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
        if (!isFileDrag(e.dataTransfer.types)) return
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
        lighting up its border in ash, sized to the whole pane instead — no new color, and it
        never lights up for reordering at all. Placed below the composer (z-20) so it does not
        cover a raised card and its shadow.
      */}
      {dragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-10 rounded-lg border border-ash"
          aria-hidden
          data-testid="pane-drop-target"
        />
      )}
      {headerDrag ? (
        <div
          className={`${HEADER} cursor-grab active:cursor-grabbing`}
          // Not while the Run menu is open — see the note on `runOpen`
          draggable={!runOpen}
          onDragStart={headerDrag}
          data-testid="pane-header"
        >
          {header}
        </div>
      ) : (
        <DragRegion className={HEADER} testId="pane-header">
          {header}
        </DragRegion>
      )}

      <ChatStream
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
      {!session.live && <DormantNote sessionId={session.id} />}

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
               * Drawing the same curve leaves nothing for it to be cut by.
               */
              `absolute inset-x-0 bottom-0 z-20 rounded-t-xl rounded-b-[7px] border border-edge bg-void px-1 pt-1 transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
                composerUp
                  ? /*
                     * The shadow's job is **to separate the card from the text it covers.**
                     * It covers the most while raised, so it is cast further — the darkness is
                     * kept the same as when collapsed (measured: both bottom out at 12, over
                     * the pane's floor color #1d1d1d), only the spread distance is increased.
                     * 25px here, 18px when collapsed.
                     */
                    'translate-y-0 shadow-[0_-19px_40px_-15px_rgb(0_0_0/0.58)]'
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
                     * This height is also why bg-panel could be restored on the input field —
                     * the bright strip that used to peek out and look like a hole in the pane's
                     * floor is gone now.
                     *
                     * This does not make the height hard to reach — what triggers the rise is
                     * not the card but the pane's 54px bottom strip (COMPOSER_REACH), so even as
                     * the visible sliver gets thinner, a hand summons the card from the same
                     * spot as before.
                     *
                     * The background is still the same color as the pane's floor, and the
                     * card's border is darker too (edge is darker than the pane's graphite). It
                     * is shape, not brightness, that says the card is there. A shadow is still
                     * cast here too (reported by a user on 2026-09-11). Cast short, but not
                     * faint — with only a 16px sliver showing, brightness alone cannot say it,
                     * so this shadow alone is what says the card is **resting on** the pane.
                     *
                     * The darkness was tuned with a ruler, not by eye: the pane's floor is
                     * #1d1d1d, so on screen, black barely moves at all — a ruler with fewer than
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
                    'translate-y-[calc(100%_-_16px)] shadow-[0_-14px_32px_-12px_rgb(0_0_0/0.6)]'
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

/**
 * The composer (FR-7).
 *
 * **There is exactly one reason this is a separate component: the draft lives in the global
 * store.** An unsent draft belongs to the session, so it has to live in the store (see the
 * `draft` comment below), which means the store changes on every keystroke. While this code
 * lived inside SessionPane, that one keystroke re-rendered **the header, the chat stream, and
 * every message bubble on screen** (measured: 1.0 renders per character for the pane, 1.0 for
 * the stream, 2.0 for each row — doubled while a response was streaming). Typing has no reason
 * to cost something proportional to the size of the conversation.
 *
 * So the place that reads the draft has been narrowed down to just this one. Everything above
 * it now passes down only `sessionId`.
 *
 * Not subscribing to the conversation (`chat`) either, for the same reason — the only place
 * that needs it is recalling with the arrow keys, and that reads it with `getState()` at the
 * moment of the keypress. Subscribing to it would re-render the composer on every streaming
 * delta, undoing exactly the cost that was just moved out of it.
 */
const Composer = memo(function Composer({
  sessionId,
  onMenuOpenChange,
  dropRef,
  framed = true,
}: {
  sessionId: string
  /** Whether the row's menu below is open — a collapsed composer must not fold away while it is (fold) */
  onMenuOpenChange?: (open: boolean) => void
  /** A handle that hands off anything dropped anywhere on the pane to this composer's own handling (#116) */
  dropRef?: Ref<ComposerDrop>
  /**
   * Whether to draw its own top border.
   *
   * When it sits directly below the conversation, that line is **the boundary between the
   * conversation and the composer.** But inside a collapsed card, the card's rounded border is
   * already the boundary, and a straight line drawn right below it looks like the corner ending
   * twice (reported by a user on 2026-09-10).
   */
  framed?: boolean
}) {
  /**
   * What the composer's text becomes for an open question (#125, #174).
   *
   * This subscribes to a narrowed-down string rather than the full array — subscribing to the
   * questions array directly would deliver a new reference every time, undoing exactly the
   * re-render this component was built to avoid. The judgment is the same one the store's send
   * uses (`composerTarget`): back when attachments were not looked at, attaching a file under
   * the "write an answer" prompt sent the text as a new turn instead, and the question was
   * dropped.
   */
  const target = useStore((s) =>
    composerTarget(s.sessions[sessionId]?.pendingQuestions ?? EMPTY_QUESTIONS, (s.drafts[sessionId]?.attachments.length ?? 0) > 0),
  )

  /*
   * Picks up **only what this actually needs** from the session.
   *
   * Subscribing to the whole session object would re-render the entire composer (the attachment
   * list, even the autocomplete menu) on every delta while a response streams — yet this
   * component only reads three things from the session, and none of the three ever changes
   * mid-conversation. Values that actually change, like model, permissions, and context, are
   * subscribed to separately by ComposerFooter below.
   */
  const alive = useStore((s) => !!s.sessions[sessionId])
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId ?? '')
  const isOrchestrator = useStore((s) => s.sessions[sessionId]?.kind === 'orchestrator')
  const send = useStore((s) => s.send)
  const wake = useStore((s) => s.wake)
  // Pulls out just this one setting — subscribing to the whole preferences record would
  // re-render the composer whenever any setting changes
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const sc = useShortcut()
  /*
   * An unsent draft belongs to **the session**, not to this component.
   *
   * Holding it with useState left the text stuck to that spot on screen. Since the focus view
   * reuses the same component when the session changes, whatever was being typed for session A
   * stayed sitting in session B's composer, and sending it went to the wrong session. In the
   * grid it was the opposite problem: switching screens unmounts the component, so the text
   * disappeared along with it — two symptoms of the same underlying cause.
   */
  const draft = useStore((s) => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const setDraft = useStore((s) => s.setDraft)

  /*
   * An older message recalled with the arrow keys (#38). `at` is its position in history,
   * `text` is what is currently shown.
   *
   * **This never overwrites the unsent draft.** While browsing history, the composer shows this
   * value instead, and the session's draft is left untouched underneath. So stepping down once
   * more past the most recent entry brings the unsent draft right back — if this had instead
   * kept a separate copy of the draft, there would inevitably come a day (switching sessions,
   * a failed send) when that copy and the real draft fell out of sync.
   *
   * It is correctly component state: "which entry in history is being viewed" is a decision
   * made in this exact moment, not a fact about the session. It is cleared below whenever the
   * session changes.
   */
  const [recall, setRecall] = useState<{ at: number; text: string } | null>(null)
  const text = recall ? recall.text : draft.text
  const attachments = draft.attachments

  const patchDraft = useCallback(
    (patch: (cur: Draft) => Draft) => {
      setDraft(sessionId, patch(useStore.getState().drafts[sessionId] ?? EMPTY_DRAFT))
    },
    [sessionId, setDraft],
  )
  const setText = useCallback(
    (next: string | ((prev: string) => string)) => {
      // While editing a recalled message, edit that message — the draft is still left untouched
      if (recall) {
        setRecall({ ...recall, text: typeof next === 'function' ? next(recall.text) : next })
        return
      }
      patchDraft((cur) => ({ ...cur, text: typeof next === 'function' ? next(cur.text) : next }))
    },
    [patchDraft, recall],
  )
  const setAttachments = useCallback(
    (next: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      patchDraft((cur) => ({
        ...cur,
        attachments: typeof next === 'function' ? next(cur.attachments) : next,
      }))
    },
    [patchDraft],
  )
  // Stable, so the memoised attachment strip does not re-render on every keystroke
  const removeAttachment = useCallback(
    (index: number) => setAttachments((p) => p.filter((_, j) => j !== index)),
    [setAttachments],
  )
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  /*
   * Whether an IME is mid-composition (issue #12).
   *
   * This is the same fact #38 already reads off a `keydown`, held for longer. A key event can
   * only answer "is this keystroke the IME's"; the question here is "is the value in the box
   * finished", and that spans every event between `compositionstart` and `compositionend` —
   * a dozen of them for five Korean syllables.
   *
   * It gates autocomplete and nothing else. `한` arrives as `ㅎ`, `하`, `한`, and with `@` in
   * front each of those is an `fs.search` for a query the person never asked for. The text is
   * deliberately *not* gated: a composing character has to appear as it is typed, so the store
   * write behind `value` stays on every event, and so does the height measurement that keeps
   * that character from being clipped.
   *
   * Note this is not a claim about latency. It removes work; whether that is visible was never
   * measured (see the investigation on #12, which could not separate render cost from the
   * frame it was waiting for).
   */
  const [composing, setComposing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachFile = useStore((s) => s.attachFile)
  /*
   * Attachments still uploading (#180). A chip only enters the draft once the host has finished
   * storing it — sending before that only sent the text, and a chip that finished late got
   * attached to the draft afterward and rode along on the *next* message instead. While
   * something is uploading, nothing sends, and the list shows what it is waiting on.
   */
  const uploading = useStore((s) => s.uploading[sessionId] ?? 0)
  /*
   * The composer's height comes **from the value.**
   *
   * This used to touch `style.height` directly in onChange, which only kept the height correct
   * when the value changed through typing. After sending, `setText('')` cleared the value but
   * left the height standing, so an empty composer sat there tall — tall with nothing written
   * in it, and back to normal the moment anything was typed (found in dogfooding). Inserting a
   * long path through autocomplete had the opposite problem: it did not grow at all.
   *
   * The number of paths that change the value will only keep growing (paste, restoring a draft,
   * switching sessions...). Instead of re-fitting the height on every one of those paths, this
   * only ever watches the single value. It is a useLayoutEffect that measures before paint, so
   * there is no flicker.
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
  }, [text])

  /*
   * A switch to a different session undoes any recall in progress (#38).
   *
   * The focus view reuses this same component when the session changes. Without clearing it,
   * text recalled from A's history would still be sitting in B's composer, and that is exactly
   * the situation an unsent draft was moved to the session to prevent — sending it as-is would
   * go to the wrong session.
   *
   * Cleared before render (layout). As an effect, someone else's text would flash for one frame.
   */
  useLayoutEffect(() => setRecall(null), [sessionId])

  // Autocomplete: `/` for skills, `@` for files
  const ac = useAutocomplete({
    sessionId,
    projectId,
    text,
    caret,
    // Not while composing (#12) — a half-formed syllable is not a query. Closing the menu also
    // hands the arrow keys back: the branch below that spends them on the list is behind `open`.
    enabled: alive && caret >= 0 && !composing,
    // The orchestrator's `@` picks a session — what it targets is a session, not a file.
    // Judged by an explicit marker (kind): the orchestrator has no file tree to pick from
    atSource: isOrchestrator ? 'sessions' : 'files',
  })

  const pick = (item: Suggestion) => {
    /*
     * A GUI command (2026-09-07): the moment it is picked from the list is the execution
     * itself — filling '/usage' into the composer and then requiring another Enter would turn
     * the promise "pressing Enter opens the screen" into two presses of Enter. This clears the
     * text and opens the screen instead.
     */
    // A session command's value has a trailing space — this does not intercept it when a real
    // skill of the same name is picked
    const gui = item.value.endsWith(' ') ? null : guiCommandFor(item.value)
    if (gui) {
      setRecall(null)
      setDraft(sessionId, EMPTY_DRAFT)
      gui.run({ sessionId })
      return
    }
    const next = ac.apply(item)
    setText(next.text)
    setCaret(next.caret)
    // The caret has to move after the value is applied (once React has rendered it)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  /**
   * Recalls a sent message with the arrow keys (#38). Returns true when history took over —
   * in that case the caret does not move.
   *
   * The judgment lives in history.ts; the caret rule lives here. History only takes over when
   * all three hold:
   *  - autocomplete is closed (if it is open, the arrow key belongs to the list — the caller
   *    has already filtered that out)
   *  - no text is selected (an arrow key with a selection is a key that clears the selection)
   *  - the caret is on the first line for the up arrow, or the last line for the down arrow —
   *    **counting wrapped lines too**
   *
   * History is scanned from the conversation fresh each time. Precomputing it would mean
   * rescanning thousands of rows on every streaming delta, when it is only ever actually used
   * at the moment an arrow key is pressed.
   */
  const recallHistory = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    /*
     * Newlines are checked first (a value comparison, free). Only what passes that gets
     * measured with the mirror — a long line that has wrapped has no newline, yet looks like
     * several lines, and an arrow key pressed in the middle of it belongs to the caret, not to
     * history (reported by a user on 2026-09-07).
     */
    const onEdge =
      dir === -1
        ? onFirstLine(text, caret) && onFirstVisualLine(el)
        : onLastLine(text, caret) && onLastVisualLine(el)
    if (!onEdge) return false

    const step = stepHistory({
      history: sentMessages(useStore.getState().chat[sessionId] ?? EMPTY_CHAT),
      at: recall?.at ?? null,
      dir,
    })
    if (step.kind === 'none') return false

    const next = step.kind === 'draft' ? draft.text : step.text
    setRecall(step.kind === 'draft' ? null : { at: step.at, text: step.text })
    /*
     * The caret goes to the end. A shell does the same, and for a single-line history entry,
     * that spot is both the first line and the last, so it can still keep scrolling up and
     * down. Recalling a multi-line entry stops there, and that is the right behavior — it was
     * pulled up to be read and edited.
     */
    setCaret(next.length)
    requestAnimationFrame(() => {
      const later = inputRef.current
      if (later) later.setSelectionRange(next.length, next.length)
    })
    return true
  }

  // Pasting a screenshot is the most common flow here (FR-13)
  // Returns "did at least one thing get attached" — the side that expands a collapsed composer
  // decides based on this (#116).
  // Expanding it when nothing was attached would bring up an empty field, lying that something happened.
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files || !alive) return false
    let added = false
    for (const f of Array.from(files)) {
      const att = await attachFile(sessionId, f)
      if (att) {
        setAttachments((prev) => [...prev, att])
        added = true
      }
    }
    return added
  }

  /*
   * All the handling for accepting a drop (#116).
   *
   * Dropping **anywhere on the pane**, not just this composer, needs to do the same thing, and
   * having two separate copies of that judgment and handling would eventually mean only one of
   * them getting fixed — a path dragged from the tree ending up in the sentence when dropped on
   * the composer, but silently disappearing when dropped elsewhere on the pane. So there is
   * exactly one place that handles it, and the pane calls into it through a handle (dropRef).
   */
  const acceptDrop = async (dt: DataTransfer) => {
    // A path dragged from the tree goes into the sentence, not into an attachment.
    // Without telling them apart, `files` would be empty and nothing would happen.
    const path = readDragPath(dt)
    if (path) {
      setText((prev) => {
        const next = appendPath(prev, path)
        // The caret has to move to the end so typing can continue from there
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(next.length, next.length)
          setCaret(next.length)
        })
        return next
      })
      return true
    }
    /*
     * Only a file from outside the app is attached (#286). A session or panel dragged inside the
     * app can carry the images it shows as files in WebKit; dropped here, that is the grid's drop,
     * and attaching the screenshot it happened to show is the bug. Checked here, in the one place
     * both the pane and the composer hand their drop to, so neither can miss it.
     */
    if (!isOsFileDrag([...dt.types])) return false
    return takeFiles(dt.files)
  }
  // No deps here — the closure above needs to see each render's draft and state, so the handle
  // must be recreated every render too
  useImperativeHandle(dropRef, () => ({ accept: acceptDrop }))

  /*
   * The pane rendering a conversation is what fetches it.
   *
   * This used to be loaded only by focusSession. In the focus view, selecting and viewing were
   * the same action, so this never showed — but the grid is a screen that **views without
   * selecting**. Putting a session that had never once been opened from the sidebar into a grid
   * cell rendered an empty pane (found in dogfooding). It is right for the component rendering
   * a single session to be the one that fetches its conversation.
   */

  // Avoid rendering even at the moment the session disappears (deleted, archived) — this is
  // decided after every hook has run
  if (!alive) return null

  return (
    <form
      className={`px-4 py-3 ${framed ? 'border-t border-edge' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t && attachments.length === 0) return
        if (uploading > 0) return
        /*
          A GUI command (2026-09-07): a name like `/usage` has no response in the protocol to
          send to the session — Enter opens an app screen instead of a message. This does not
          intercept it if there is an attachment: attaching something means the person is
          talking to the session.
        */
        const gui = attachments.length === 0 ? guiCommandFor(t) : null
        if (gui) {
          setRecall(null)
          setDraft(sessionId, EMPTY_DRAFT)
          gui.run({ sessionId })
          return
        }
        /*
            After sending, the composer really does go empty (#38).
            **Both** the recall state and the draft have to be cleared — clearing only one
            would bring the earlier unsent text back to life right where the message was just
            sent. The message just sent is now at the top of history, so one press of the
            arrow key brings it back if needed.
          */
        setRecall(null)
        setDraft(sessionId, EMPTY_DRAFT)
        void send(sessionId, t, attachments)
      }}
    >
      {(attachments.length > 0 || uploading > 0) && (
        <AttachmentStrip attachments={attachments} uploading={uploading} onRemove={removeAttachment} />
      )}
      <div
        /*
         * The input field is filled in **again** (reported by a user on 2026-09-11).
         *
         * It was cleared on 09-10 because "a resting input field is brighter than the
         * conversation". That diagnosis overlapped with a separate issue, where one row of
         * panel peeked out above the pane's floor as the card collapsed and looked like a hole
         * — now that the collapsed height has been lowered enough to hide the input field
         * itself, that side effect is gone. What remains is only the original purpose: the
         * surface for typing has to be **a different surface** from the one for reading.
         *
         * The rule that brightness marks something currently happening is still kept by the
         * border — graphite on focus, ash when a file is dragged over it.
         */
        className={`relative flex items-end gap-2 rounded border bg-panel px-3 py-2 transition-colors focus-within:border-graphite ${
          dragging ? 'border-ash' : 'border-edge'
        }`}
        onDragEnter={(e) => {
          e.preventDefault()
          // Lit only for what it would take — a session dragged over it is the grid's (#286)
          if (isFileDrag(e.dataTransfer.types)) setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          // A leave event also fires when moving into a child, so this only reacts to actually leaving
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void acceptDrop(e.dataTransfer)
        }}
        data-testid="input-dropzone"
      >
        {ac.open && (
          <AutocompleteMenu
            items={ac.items}
            index={ac.index}
            loading={ac.loading}
            kind={ac.kind}
            onPick={pick}
          />
        )}
        <textarea
          ref={inputRef}
          className="max-h-40 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-chalk placeholder:text-slate focus:outline-none"
          rows={1}
          value={text}
          /*
              Focusing here wakes the session, exactly as selecting it in the sidebar does
              (focusSession → wake). This second call site exists because two paths reach a
              composer without ever selecting: a grid panel's input, and the session a
              restart restored into focus. Both sat asleep until send — so the seconds a
              resume takes ran after the send button instead of during the typing, and the
              slash list could only answer from the disk cache (which kept serving an
              uninstalled plugin's commands). wake() dedups and stays quiet, so a second
              call on an already-live session costs nothing.
            */
          onFocus={() => void wake(sessionId)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            // While autocomplete is open, the arrow keys, Enter and Tab belong to the list
            if (ac.open) {
              if (e.key === 'ArrowDown') return (e.preventDefault(), ac.move(1))
              if (e.key === 'ArrowUp') return (e.preventDefault(), ac.move(-1))
              if (e.key === 'Escape') return (e.preventDefault(), setCaret(-1))
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                const item = ac.items[ac.index]
                if (item) {
                  e.preventDefault()
                  pick(item)
                  return
                }
              }
            }
            /*
                While an IME is composing, Enter and the arrows belong to **the candidate list**,
                not to us (#38, #12). The arrows move through candidates; Enter commits the
                syllable being formed. Enter is the worse one to take: our answer to Enter is to
                send, so the keystroke that was meant to finish a word posts a half-written
                message instead — and Korean needs that keystroke far more often than English,
                which is the shape of "this only happens in Korean".

                This reads the key event rather than the `composing` state above, on purpose. The
                state answers "is the value still forming", which is the right question for
                autocomplete and the wrong one for a keystroke: it is set from an event that in
                principle might not arrive, and a stuck `true` there would mean a message that
                cannot be sent at all. These flags are scoped to this one key and cannot go stale.
                Both are read because `isComposing` is the standard signal and some browsers
                report the key itself as `Process` instead.
              */
            const composing = composingKey({ key: e.key, isComposing: e.nativeEvent.isComposing })
            if (!composing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              if (recallHistory(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1)) {
                e.preventDefault()
                return
              }
            }
            /*
                What counts as sending is decided by the setting (composerKeys.ts). This does
                not judge it directly here because the combination of cases it is tangled up
                with, together with the composition check (composing) above, needs to live
                somewhere testable without a browser.

                For someone who has turned the setting on, a plain Enter does nothing here — it
                is not intercepted, so the textarea just breaks the line as usual. That is the
                entire effect of the setting.
              */
            const sendKey = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing }
            if (isComposerSendKey(sendKey, sendWithModifierEnter)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length > 0) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          /*
           * With a question open, **whatever is typed here goes as the answer to that
           * question** (#125). That fact needs to be known before pressing send — this used to
           * silently drop the question, and the person did not even know what they had just
           * gotten rid of.
           */
          placeholder={
            target === 'answer'
              ? 'Type your answer to the question'
              : target === 'drops'
                ? 'Sending starts a new turn and drops the question card — answer on the card instead'
                : 'Type a message'
          }
          data-testid="prompt-input"
        />
        {/*
            The attach button uses **the same component** as send. It used to be a separate one
            built from a label, with different inner padding (6px vs 4px) and icon size (16 vs
            15), so the two buttons standing side by side looked mismatched in size and height
            (found in dogfooding). The file picker is opened by clicking a hidden input — it
            does the same job without a label.
          */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid="attach-input"
          onChange={(e) => {
            /*
             * The chosen files are copied out before the field is cleared (#180). If the value
             * were left as-is, the browser would not fire `change` again for picking the same
             * file a second time, so removing the chip (or sending it) meant the same file could
             * never be attached again. `files` is a live list, so clearing the value clears it
             * too — this copies it into an array first, then clears.
             */
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            void takeFiles(files)
          }}
        />
        <IconButton
          label="Attach file"
          onClick={() => fileRef.current?.click()}
          testId="attach-open"
          placement="top"
          className="shrink-0"
        >
          <PlusIcon size={15} />
        </IconButton>
        <IconButton
          type="submit"
          /*
            The label follows the setting, since the send key itself changes with it. This is
            **the only place in the app that names that key**, so getting it wrong leaves
            someone who turned the setting on with no way to know what to press the first time.
            Whether it reads `⌘` or `Ctrl` is answered by the keyboard.
          */
          label={`Send (${sendWithModifierEnter ? sc('mod', 'Enter') : 'Enter'})`}
          disabled={(!text.trim() && attachments.length === 0) || uploading > 0}
          testId="send"
          placement="top"
          align="right"
          className="shrink-0 text-ash"
        >
          <SendIcon />
        </IconButton>
      </div>
      {/*
          Model, effort and permissions are decided **right before sending**, so they sit below
          the composer. In the header they were at the opposite end of the screen, so what was
          being sent and under which settings never showed together at a glance. Here, the hand
          and the eye stay in the same spot.
        */}
      {/*
          The shortcut hint was removed. Sending with Enter and breaking the line with
          Shift+Enter is the default for a chat composer — learned once and done — but a hint
          takes up space every single time. Once read, it is noise from then on (dogfooding:
          "because these are obvious").
        */}
      <ComposerFooter sessionId={sessionId} onMenuOpenChange={onMenuOpenChange} />
    </form>
  )
})

/**
 * The row below the composer — model, effort, permissions, worktree, context.
 *
 * **Why this subscribes separately** from the composer: the values here keep changing during
 * the conversation (context on every turn, live on every restart), and the composer has nothing
 * to do with any of that. Back when this was one component, the textarea itself was re-rendered
 * whole on every delta while a response streamed.
 *
 * The placement is unchanged — model and permissions are decided **right before sending**, so
 * they belong here, where the hand and eye already are, rather than in the header at the
 * opposite end of the screen.
 */
const ComposerFooter = memo(function ComposerFooter({
  sessionId,
  onMenuOpenChange,
}: {
  sessionId: string
  onMenuOpenChange?: (open: boolean) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  if (!session) return null
  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SessionSettings
        sessionId={session.id}
        // Not the project's default — **this session's** tool (tools can be mixed)
        tool={session.tool}
        model={session.model}
        effort={session.effort}
        verbosity={session.verbosity}
        serviceTier={session.serviceTier}
        preset={session.permissionPreset}
        live={session.live}
        onOpenChange={onMenuOpenChange}
      />
      {/*
          A worktree session **runs in a different directory.** If that fact is not visible,
          people open the project folder and run into "why has nothing changed" — placing it
          next to the settings makes what is running where readable in one spot.
        */}
      {session.worktree && (
        <span
          className="readout truncate text-[10px] text-slate"
          title={`Runs in a git worktree: ${session.worktree.path}`}
          data-testid="worktree-badge"
        >
          ⑂ {session.worktree.branch}
        </span>
      )}
      {/*
          Context is placed **next to where it is used**, too. In the conversation header it sat
          at the opposite end of the screen, so during a long write-up, how much was actually
          left never registered (found in dogfooding).

          **Unknown and 0% are told apart.** A session that has never finished a turn has no
          value. Showing 0% at that point would be a lie that says "nothing has been used yet" —
          a dim `—` means it is unknown.

          (Before #48, a restarted session also fell into this. `context` was not in the
          database, so quitting and reopening the app made the value disappear. It is persisted
          now, so a blank truly only ever means "never reported at all".)
        */}
      <span
        className={`readout ml-auto shrink-0 text-[11px] ${
          ctxPct === null ? 'text-slate/50' : ctxPct >= 80 ? 'text-chalk' : 'text-slate'
        }`}
        data-testid="context-gauge"
        title={
          session.context
            ? `Context ${session.context.used.toLocaleString()} / ${session.context.window.toLocaleString()} tokens`
            : 'Context unknown — this session has never reported one'
        }
      >
        Context {ctxPct === null ? '—' : `${ctxPct}%`}
      </span>
    </div>
  )
})

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
function ChatStream({
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
    getItemKey: (i) => chat[i]?.seq ?? i,
    /*
     * The scroller's size-change compensation is applied to where the view is now, not to the
     * offset the scroller last saw in a scroll event — which is a frame stale right after our
     * own landing or following write, and put the view 54px above the end in WebKit (see
     * `writeScroll`).
     */
    scrollToFn: (offset, options, instance) => {
      if (instance.scrollElement) writeScroll(instance.scrollElement, offset, options)
    },
  })

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
    if (landed.current || chat.length === 0) return
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
          // The target has stopped moving = every row above it has been measured. No reason to wait any longer
          if (Math.abs(target - prev) <= 1) setSettling(false)
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
  }, [sessionId, chat.length, scrollRef])

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
        if (e.deltaY < 0) noteInput()
      }}
      onPointerDown={() => {
        endLanding()
        held.current = true
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
      className={`min-h-0 flex-1 overflow-y-auto px-4 pt-4 text-[13px] leading-relaxed ${
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
              convey. The color replaces the composited color that graphite/55 used to produce
              over void with a panel token instead — the visible brightness is unchanged.
            */}
            <button
              type="button"
              onClick={() => setStickyOpen((v) => !v)}
              aria-expanded={stickyOpen}
              className="w-full cursor-pointer truncate rounded-lg rounded-br-sm border border-slate/40 bg-graphite px-3 py-2 text-left text-[13px] text-chalk shadow-[0_8px_24px_-8px_rgb(0_0_0/0.8)]"
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
                className="absolute inset-x-0 top-0 z-10 max-h-60 cursor-pointer overflow-y-auto whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-slate/40 bg-graphite px-3 py-2 text-left text-[13px] text-chalk shadow-[0_8px_24px_-8px_rgb(0_0_0/0.8)]"
              >
                {stickyText}
              </button>
            )}
          </div>
        </div>
      )}

      <OlderSentinel sessionId={sessionId} scrollRef={scrollRef} />

      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
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
            className={`absolute left-0 top-0 w-full min-w-0 ${
              chat[v.index]?.kind === 'user' ? 'pb-4 pt-6' : 'pb-3'
            } ${v.index === stickyIndex && stickyText !== null ? 'invisible' : ''}`}
            style={{ transform: `translateY(${v.start}px)` }}
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

/**
 * The indicator that says a response is being waited for.
 *
 * It is common for the first character to take tens of seconds to arrive, and if the screen is
 * completely quiet the whole time, **there is no way to tell whether it is working or has
 * stopped** (found in dogfooding).
 *
 * So two things are shown together:
 *   - A moving dot: "it is alive". In the end, movement is the only thing that sets it apart
 *     from a frozen screen.
 *   - Elapsed time: "how long has this been going". 3 seconds and 3 minutes are not the same
 *     kind of "waiting" — watching the number climb also confirms it has not stopped.
 *
 * The stop button lives here too. It is also at the top, but the eyes of someone waiting are at
 * the bottom of the conversation.
 *
 * **The count is derived; only the tick lives here** (issue #23). This used to read
 * `Date.now()` on mount and treat that as the start of the turn, which held right up until
 * the component was remounted — switching to the grid and back, or moving between sessions,
 * put a three-minute turn back at zero. The lie was small and in the worst direction: the
 * longer a wait, the more the number understated it.
 *
 * Keeping the component alive would not have been the fix. What was stored was the wrong
 * thing — an elapsed count, which is derived, and derived values should not be the thing
 * that survives. The start instant lives on the store now (`workingSince`), and this
 * subtracts it from the current time. The interval below no longer carries any state; it
 * exists only to make the clock re-read once a second.
 */
function ActivityRow({ sessionId, activity }: { sessionId: string; activity: SessionSummary['activity'] }) {
  const interrupt = useStore((s) => s.interrupt)
  const startedAt = useStore((s) => s.workingSince[sessionId])
  // The amount of thinking (#58) — Claude's thinking body is encrypted, so this estimate is all
  // there is to show
  const thinkingTokens = useStore((s) => s.sessions[sessionId]?.thinkingTokens ?? null)
  // A plan snapshot (#58, Codex) — it has the same lifetime as activity, so this row (which
  // only lives while working) is the right home for it
  const plan = useStore((s) => s.sessions[sessionId]?.plan ?? null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // No instant means we genuinely do not know when this turn began — say nothing rather
  // than start a fresh count, which is the mistake this whole row is here to stop making
  const seconds = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div className="py-2" data-testid="activity-row">
      {/*
        The plan checklist (#58, Codex's turn/plan/updated). Being progress display, it lives
        here (visible only while working) — it disappears along with activity once the turn
        ends. Status is told apart by glyph, not color (the palette rule: distinguish by shape).
      */}
      {plan && plan.length > 0 && (
        <ul className="mb-1.5 flex flex-col gap-0.5" data-testid="activity-plan">
          {plan.map((step, i) => (
            <li
              key={i}
              className={`flex items-baseline gap-1.5 text-[11px] ${step.status === 'inProgress' ? 'text-chalk' : 'text-slate'}`}
              data-testid={`plan-step-${i}`}
              data-status={step.status}
            >
              <span className="readout shrink-0" aria-hidden>
                {step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '▸' : '○'}
              </span>
              <span className={step.status === 'completed' ? 'line-through opacity-60' : undefined}>
                {step.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <span className="size-1.5 animate-pulse rounded-full bg-chalk" aria-hidden />
        {/*
        Not the same kind of "waiting". Compacting has been measured to take up to 39 seconds,
        and with the same wording, someone waiting has no way to tell whether it has stopped or
        is just taking a while.
      */}
        <span className="text-[12px] text-ash" data-testid="activity-label">
          {activity === 'compacting'
            ? 'Compacting context'
            : activity === 'reviewing'
              ? 'Reviewing changes'
              : // Codex's own word for it (#168): the connection dropped and it is trying again
                activity === 'retrying'
                ? 'Reconnecting'
                : thinkingTokens
                ? `Thinking · ~${thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tokens`
                : 'Waiting for response'}
        </span>
        {/* Showing a number for a one-second wait would just be noise */}
        {seconds >= 2 && (
          <span className="readout text-[11px] text-slate" data-testid="activity-elapsed">
            {formatElapsed(seconds)}
          </span>
        )}
        <button
          type="button"
          className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-slate transition-colors hover:border-graphite hover:text-chalk"
          onClick={() => void interrupt(sessionId)}
          data-testid="activity-interrupt"
        >
          Stop
        </button>
      </div>
    </div>
  )
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min}m ${seconds % 60}s`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

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
function OlderSentinel({
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
        className="readout rounded border border-edge px-2 py-0.5 text-[10px] text-slate transition-colors hover:border-graphite hover:text-chalk disabled:opacity-60"
      >
        {loading ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
    </div>
  )
}

/**
 * A session with no process.
 *
 * This used to block with "This session is not running" and require pressing [Continue]. That
 * pushes a machine-level concern onto the person — all they want is to keep talking, and the
 * means to continue is already something this app has. Now sending a message lets the host
 * resume it on its own. This just quietly says so (so it comes as no surprise).
 */
function DormantNote({ sessionId }: { sessionId: string }) {
  const waking = useStore((s) => !!s.resuming[sessionId])
  const error = useStore((s) => s.wakeError[sessionId])
  const locked = useStore((s) => !!s.wakeLocked[sessionId])
  const wake = useStore((s) => s.wake)
  const fork = useStore((s) => s.forkConversation)

  // If there is a reason it could not be resumed, that is said first — "sending resumes it"
  // would no longer be true
  if (error && !waking) {
    return (
      <p
        className="flex items-center gap-2 border-t border-edge px-4 py-1.5 text-[11px] leading-relaxed text-ash"
        data-testid="dormant-note"
      >
        <span className="min-w-0 flex-1 break-words">Could not resume — {error}</span>
        {/*
         * When something else is holding the lock, **retrying alone never opens it** — the
         * only way forward used to be going and closing the other app. A way to fork and
         * continue is placed right there alongside it. The fact that it leaves the original
         * untouched has to be spelled out too, or pressing it feels risky.
         */}
        {locked && (
          <button
            className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
            onClick={() => void fork(sessionId)}
            title="Continue in a copy of this conversation. The original stays untouched."
            data-testid="dormant-fork"
          >
            Continue in a fork
          </button>
        )}
        <button
          className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
          onClick={() => void wake(sessionId)}
          data-testid="dormant-retry"
        >
          Retry
        </button>
      </p>
    )
  }

  return (
    <p className="border-t border-edge px-4 py-1.5 text-[11px] text-slate" data-testid="dormant-note">
      {waking ? 'Waking session…' : 'Dormant — sending a message resumes it automatically'}
    </p>
  )
}

/**
 * A single message bubble row.
 *
 * **The reason for memo is streaming.** While a response streams, each delta only changes the
 * last row (the store's message_delta leaves every other item's identity untouched), and
 * without memo, every visible bubble on screen was re-rendered **entirely** on each chunk — with
 * a long answer filling the screen, that means re-parsing markdown many times over (measured:
 * 2.7 renders per character). Markdown itself is already memoized, but that alone cannot stop
 * the shell above it from running fresh every time.
 */
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

const ChatRow = memo(function ChatRow({
  item,
  projectRoot,
  projectId = null,
  sessionId,
  leaving = false,
  nested = false,
}: {
  item: ChatItem
  projectRoot: string | null
  /** The owner of projectRoot — so file links open in this pane's project (#182) */
  projectId?: string | null
  sessionId: string
  /**
   * This is a row the list is about to detach — if it has an app view, sends teardown and
   * collapses it (M4 B-1)
   */
  leaving?: boolean
  /**
   * A subagent's step drawn inside its launch card (#222), not a row of the conversation. An app
   * view stands under the parent's own calls only — the host opens none for a subagent's.
   */
  nested?: boolean
}) {
  if (item.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5" data-testid="msg-user">
        {/*
          A message that came in through delegation (FR-11). Placed in the same spot (right) as
          the person's own messages — to the session it is equally "a directive received" —
          but with a source name above it and the border switched to dashed. No color is used
          (the palette rule): the distinction is made by shape, not brightness.
        */}
        {item.from && (
          <div className="text-[11px] text-ash" data-testid="msg-user-from">
            {item.from.name} ⤷
          </div>
        )}
        {/*
          A message sent by an in-conversation app view (M4 B-1). A person chose to send it, but
          the app wrote it — shown in the same shape as a delegated message (dashed border, a
          one-line source), noting that the source is an app rather than a session.
        */}
        {item.fromApp && (
          <div className="text-[11px] text-ash" data-testid="msg-user-from-app">
            {item.fromApp.name} app ⤷
          </div>
        )}
        {/*
          A string with no whitespace, like a long URL or path, does not wrap under the default
          rule. That makes the bubble spill sideways and puts a horizontal scrollbar on the
          whole conversation (found in dogfooding). whitespace-pre-wrap keeps line breaks the
          person typed, and break-words breaks even a long chunk that otherwise could not wrap.
        */}
        {/*
          Contrast against the background (void, #141414) is what makes "something I said"
          visible. panel (#1d1d1d) plus edge (#292929) is only two steps apart, and was
          effectively invisible in a dark room (found in dogfooding). This lifts it to graphite,
          the same as the hover background, and gives the border one step more brightness.
        */}
        {/*
          Attachments stand as real objects above the body text — an image as a thumbnail
          (click to zoom), a file as a named chip. This used to render "📎 name" mixed into the
          text, which was a list, not a picture, and it even caused the side effect (#75) of the
          sent text differing from the rendered text.
        */}
        {item.attachments && item.attachments.length > 0 && (
          <div className="flex max-w-[75%] flex-wrap justify-end gap-1.5">
            {item.attachments.map((a, i) => (
              <UserAttachment key={`${a.path}-${i}`} att={a} />
            ))}
          </div>
        )}
        {/* No empty bubble is rendered for a message that only sent an image */}
        {(item.text || !item.attachments?.length) && (
          <div
            className={`max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border bg-graphite px-3 py-2 text-chalk ${
              item.from || item.fromApp ? 'border-dashed border-ash/50' : 'border-slate/40'
            }`}
          >
            {item.text}
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="min-w-0" data-testid="msg-assistant">
        <Markdown text={item.text} projectRoot={projectRoot} projectId={projectId} />
      </div>
    )
  }
  if (item.kind === 'reasoning') {
    /*
     * A reasoning summary (#58). It is the path to the body, not the body itself, so it is
     * dimmed one step to ash — following the ink rule exactly, where brightness signals
     * importance. Codex's summary arrives as **bold heading** markdown, so this is still
     * rendered through Markdown, just left quiet with no background color.
     */
    return (
      <div className="min-w-0 text-[13px] text-ash [&_strong]:text-ash" data-testid="msg-reasoning">
        <Markdown text={item.text} projectRoot={projectRoot} projectId={projectId} />
      </div>
    )
  }
  if (item.kind === 'approval') {
    // A pending approval is already shown by the card right below it, so this row only appears
    // once a decision has been made
    if (!item.decision) return null
    return (
      <p className="readout text-[11px] text-slate" data-testid="msg-approval-log">
        {item.decision === 'deny' ? 'Denied' : 'Allowed'} · {item.summary}
      </p>
    )
  }
  if (item.kind === 'mark') {
    /*
     * The label **shrinks and wraps.**
     *
     * This row was built for **short divider labels** like "conversation compacted here", so
     * `shrink-0` was the right value at the time. But once a failed turn started being shown on
     * screen (#107), error sentences ended up in the same spot — a single line like "Your
     * access token could not be refreshed because your refresh token was revoked…" pushed the
     * row wide and **put a horizontal scrollbar on the whole conversation** (found in
     * dogfooding). A sentence the person needs to read being pushed off screen defeats the
     * point of showing it at all.
     *
     * The lines on either side are `flex-1`, so they only ever draw whatever space the label
     * leaves over — center alignment holds even when the label wraps to several lines, and a
     * short label still looks exactly as it did before.
     */
    return (
      <div className="flex items-center gap-2 py-1" data-testid="msg-mark">
        <span className="h-px flex-1 bg-edge" />
        <span className="readout min-w-0 break-words text-center text-[10px] text-slate">{item.text}</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
    )
  }
  if (item.kind === 'image') {
    /*
     * An image produced by the agent (#40). Display-only, so it is never stored — it disappears
     * on restart, like terminal scrollback. When there is no `data`, this states the reason
     * instead of a silent blank (failures stay visible — an app-wide rule).
     */
    if (!item.data) {
      return (
        <div
          className="rounded-lg border border-edge bg-panel px-3 py-2 text-[12px] text-slate"
          data-testid="msg-image-missing"
        >
          The image could not be displayed{item.note ? ` — ${item.note}` : ''}
          {item.path && <span className="readout mt-1 block truncate text-[11px]">{item.path}</span>}
        </div>
      )
    }
    return <ImageMessage mime={item.mime} data={item.data} path={item.path} />
  }
  // The orchestrator's project proposal (#63) — a single line pointing at the sidebar rather
  // than a tool card
  if (/propose_project$/.test(item.tool)) return <ProjectProposalRow item={item} />
  // A manager's worktree proposal (#69) — the same principle: point at it, and the value
  // (branch name) is pre-filled into the window
  if (/propose_worktree_session$/.test(item.tool)) return <WorktreeProposalRow item={item} />
  return (
    <>
      <ToolCard item={item} sessionId={sessionId} projectRoot={projectRoot} projectId={projectId} />
      {/* The app view this call opened (M4 B-1) — its own view is looked up by the card's id.
      Nothing is rendered if there is none */}
      {item.callId && !nested && <InlineViewSlot sessionId={sessionId} callId={item.callId} leaving={leaving} />}
    </>
  )
})

/**
 * An image inside the conversation (#40, extended to zoom in #62).
 *
 * In the body it is clipped at max-h-80, so text in a screenshot cannot be read — clicking it
 * opens a larger view in a modal. Why the Modal component is reused as-is: being a portal, it
 * is never trapped by a grid cell's overflow (the pitfall called out in #62), and closing via
 * Esc or an outside click does not have to be rebuilt.
 */
function ImageMessage({ mime, data, path }: { mime?: string; data: string; path?: string }) {
  return (
    <div className="min-w-0" data-testid="msg-image">
      <ZoomableImage
        src={`data:${mime};base64,${data}`}
        alt={path ?? 'agent image'}
        /* Clipped so it never covers the whole screen vertically — the original aspect ratio is kept */
        thumbClassName="max-h-80 max-w-full rounded-lg border border-edge"
      />
    </div>
  )
}

/** A thumbnail-plus-zoom pair — an agent image (#40) and a user attachment use the same zoom */
function ZoomableImage({
  src,
  alt,
  thumbClassName,
  onError,
}: {
  src: string
  alt: string
  thumbClassName: string
  onError?: () => void
}) {
  const [zoom, setZoom] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} title={alt} className="block cursor-zoom-in">
        <img src={src} alt={alt} className={thumbClassName} onError={onError} />
      </button>
      {zoom && (
        <Modal onClose={() => setZoom(false)} testId="image-lightbox">
          {/* vh/vw know nothing about zoom — the same correction as every other modal
          (index.css --text-zoom) */}
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(90vh/var(--text-zoom))] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-edge"
          />
        </Modal>
      )}
    </>
  )
}

/**
 * An attachment shown as itself when it can be: an image with bytes becomes a zoomable thumbnail,
 * anything else — a file, an image whose bytes are gone (cleaned up past the 500MB cap after a
 * restart), or bytes the browser cannot decode — becomes `chip`.
 *
 * Shared by the sent bubble and the composer (#284), so that what is about to be sent and what was
 * sent are decided by the same rule: an image that would show as a chip in the bubble shows as a
 * chip in the composer too. `frame` wraps the thumbnail; each side adds its own surroundings (the
 * composer's remove button).
 *
 * The data URL is memoised. The composer re-renders on every keystroke, and building a string the
 * size of a screenshot for each one would hand React a new multi-megabyte `src` to compare every
 * time; the same string object compares by identity.
 */
function AttachmentThumb({
  att,
  thumbClassName,
  chip,
  frame,
}: {
  att: ChatAttachment
  thumbClassName: string
  chip: ReactNode
  frame: (img: ReactNode) => ReactNode
}) {
  const [broken, setBroken] = useState(false)
  const src = useMemo(() => (att.data ? `data:${att.mime};base64,${att.data}` : null), [att.mime, att.data])
  if (att.kind !== 'image' || !src || broken) return <>{chip}</>
  return frame(<ZoomableImage src={src} alt={att.name} thumbClassName={thumbClassName} onError={() => setBroken(true)} />)
}

/**
 * What an attachment's chip says: a short kind label and the name.
 *
 * No emoji here — they look different across OS and font, and most are in color, which
 * immediately breaks the rule "color belongs only to the diff body". A short text label has
 * neither problem.
 */
function AttachmentLabel({ att }: { att: ChatAttachment }) {
  return (
    <>
      <span className="readout text-[9px] text-slate" title={att.kind === 'image' ? 'Image' : 'File'}>
        {att.kind === 'image' ? 'IMG' : 'DOC'}
      </span>
      <span className="max-w-40 truncate">{att.name}</span>
    </>
  )
}

/**
 * A single attachment the person sent along with a message.
 *
 * An image stands as a real thumbnail; anything that cannot (see AttachmentThumb) falls back to
 * the same notation as the composer's chip (IMG/DOC plus a name) — what was sent has to remain
 * visible even once the bytes are gone.
 */
function UserAttachment({ att }: { att: ChatAttachment }) {
  return (
    <AttachmentThumb
      att={att}
      /* Sits next to a message bubble, so its cap is set lower than an agent image's */
      thumbClassName="max-h-48 max-w-full rounded-lg border border-slate/40"
      chip={
        <span
          className="flex items-center gap-1.5 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-ash"
          data-testid="msg-user-attachment"
          title={att.name}
        >
          <AttachmentLabel att={att} />
        </span>
      }
      frame={(img) => <span data-testid="msg-user-attachment">{img}</span>}
    />
  )
}

/**
 * The composer's attachments, before sending (#284).
 *
 * An image shows as a small thumbnail rather than an `IMG` chip: a pasted screenshot's name is
 * generated, so the chip said nothing about which image it was, and the person found out only
 * after sending. A file keeps its chip, and so does an image that cannot be drawn (AttachmentThumb).
 *
 * **Every item sits in a row of one fixed height** (`h-12`, the thumbnail's height). Items of
 * different heights would make the strip, and with it the composer, grow and shrink as a thumbnail
 * is added, removed or falls back to a chip — the composer jumping under the hand while typing,
 * and the measured card height (composerH) shifting the conversation's bottom margin each time.
 * With one row height the strip only changes height when it wraps to another row, and several
 * thumbnails wrap into even rows.
 *
 * Memoised: the strip's props do not change on a keystroke (the draft's attachment array keeps its
 * identity when only the text changes), so typing does not re-render the thumbnails.
 */
const AttachmentStrip = memo(function AttachmentStrip({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: ChatAttachment[]
  uploading: number
  onRemove: (index: number) => void
}) {
  return (
    <ul className="mb-1.5 flex flex-wrap items-center gap-1.5" data-testid="attachment-list">
      {uploading > 0 && (
        <li className="flex h-12 items-center">
          <span
            className="flex items-center gap-1.5 rounded border border-dashed border-edge px-2 py-1 text-[11px] text-slate"
            data-testid="attachment-uploading"
          >
            Attaching {uploading === 1 ? 'a file' : `${uploading} files`}…
          </span>
        </li>
      )}
      {attachments.map((a, i) => {
        const remove = (
          <button
            type="button"
            className="text-slate transition-colors hover:text-chalk"
            onClick={() => onRemove(i)}
            aria-label={`Remove attachment ${a.name}`}
          >
            <CloseIcon size={11} />
          </button>
        )
        return (
          <li key={`${a.path}-${i}`} className="flex h-12 items-center" data-testid="attachment-item">
            <AttachmentThumb
              att={a}
              /*
               * The row's height, a width between square and twice that, cropped to fill — a
               * wide screenshot and a tall one take a similar, bounded footprint. Clicking it
               * opens the same zoom as the sent bubble's thumbnail.
               */
              thumbClassName="h-12 w-auto min-w-12 max-w-24 rounded border border-edge object-cover"
              chip={
                <span
                  className="flex items-center gap-1.5 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-ash"
                  data-testid="attachment-chip"
                  title={a.name}
                >
                  <AttachmentLabel att={a} />
                  {remove}
                </span>
              }
              frame={(img) => (
                /*
                 * The remove button sits on the thumbnail's corner over a dimmed backing, so it
                 * reads on a light screenshot as well as a dark one without adding a color.
                 */
                <span className="relative block" data-testid="attachment-thumb">
                  {img}
                  <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-sm bg-void/80">
                    {remove}
                  </span>
                </span>
              )}
            />
          </li>
        )
      })}
    </ul>
  )
})

/**
 * A project proposal (#63) — **a pointing finger, not a button.**
 *
 * This originally had a folder picker button attached to it here. Dogfooding showed that was
 * wrong: it created a second door doing exactly what the sidebar's Add project already does,
 * and someone seeing this for the first time would learn that "a project is something the
 * orchestrator is asked to do" — exactly the opposite of how it should work. It also broke, right at
 * that moment, the rule that there is exactly one way to pick a folder in this app (the
 * sidebar's Add project).
 *
 * So this row does nothing at all. Instead, **the sidebar's button lights up**
 * (the store's addProjectHint). What the orchestrator does is not open the door on someone's
 * behalf, but point at where the door is — and a place learned once is found unaided the next
 * time.
 */
function ProjectProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  // The adapter sends the reason riding on the title (a special case for propose_project in
  // normalize) — with no reason, the tool name comes through as-is, so this falls back to a
  // default sentence in that case
  const reason = item.title && !/propose_project$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-baseline gap-2 text-[12px] text-ash" data-testid="project-proposal">
      {/* Points down and to the left — the actual direction of the lit-up button */}
      <span className="shrink-0 text-slate" aria-hidden>
        ↙
      </span>
      <span>
        <span className="text-chalk">Add project</span> at the bottom of the sidebar
        {reason ? ` — ${reason}` : ''}
      </span>
    </p>
  )
}

/**
 * A worktree proposal (#69) — the same principle as propose_project (one door, this is only a
 * finger pointing at it), with one value riding along: the branch name. The sidebar's + button
 * lights up, and opening that door brings up a dialog with the worktree toggle already on and
 * the name pre-filled. Creating it is, to the very end, the person's own act.
 */
function WorktreeProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const branch = item.title && !/propose_worktree_session$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-baseline gap-2 text-[12px] text-ash" data-testid="worktree-proposal">
      <span className="shrink-0 text-slate" aria-hidden>
        ↖
      </span>
      <span>
        {branch ? (
          <>
            Branch <span className="font-mono text-chalk">{branch}</span> proposed
          </>
        ) : (
          'A worktree session was proposed'
        )}
        {' — the '}
        <span className="text-chalk">+</span>
        {' button on this project opens the prefilled dialog'}
      </span>
    </p>
  )
}

/**
 * The number of lines shown as a preview while collapsed — just enough to recognize what
 * command produced what
 */
const PREVIEW_LINES = 3

/**
 * The preview's **height cap** (reported by a user on 2026-09-12).
 *
 * `PREVIEW_LINES` counts lines split by `\n`. But there is no guarantee one logical line renders
 * as one visual line: something like a resource-upload response, one blob of JSON with no
 * newlines, is logically one line, so the preview truncation cuts nothing at all, and on screen
 * it wraps into dozens of lines, with the card covering the entire conversation. That is what
 * "collapsed, but everything is showing" meant.
 *
 * So one more cap is added — a height counted in **visible lines**. `lh` is one line-height unit
 * of that element, so `3lh` is always exactly three lines regardless of font size or leading
 * changes (writing it in px would mean hand-rounding a value like
 * leading-relaxed × 11px = 17.875px, and that rounding would show one pixel of a fourth line's
 * top edge).
 */
const PREVIEW_CLAMP = 'max-h-[3lh] overflow-hidden'

/**
 * The tool card.
 *
 * **No scrolling inside it.** A small scroll area inside the conversation intercepts the wheel,
 * so trying to scroll the conversation instead scrolls inside the card while the conversation
 * stays put (called out as "annoying" in dogfooding). Scrolling belongs to exactly one thing,
 * the conversation itself — collapsed shows a preview, expanded shows everything. Length is
 * decided by the person.
 *
 * **Collapsed by default.**
 *
 * This used to collapse only read-only tools and expand changes (Bash, Edit, MCP). The thinking
 * was that changes need to be seen, but in practice, using a tool even a few times buried the
 * conversation in output, making the actual answer unreadable (found in dogfooding). What was
 * done is already said by the title row — whether that is a command or a path.
 *
 * Two things are never lost even while collapsed: a failure stays visible as 'Failed' in the
 * title row, and a few lines of output preview are shown as-is.
 */
function ToolCard({
  item,
  sessionId,
  projectRoot,
  projectId,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  sessionId: string
  projectRoot: string | null
  projectId: string | null
}) {
  const [open, setOpen] = useState(false)
  const lines = item.result ? item.result.replace(/\s+$/, '').split('\n') : []
  const hidden = Math.max(0, lines.length - PREVIEW_LINES)
  /*
   * Whether the height cap **actually kicked in** cannot be known by counting — where wrapping
   * happens is decided by the card's width. This has to be measured instead. Without it, one
   * blob with no newlines (hidden === 0) gets clipped silently: the worst state is one where
   * nothing tells anyone there is more to expand.
   */
  const outRef = useRef<HTMLPreElement>(null)
  const [clamped, setClamped] = useState(false)
  useLayoutEffect(() => {
    const el = outRef.current
    if (!el || open) {
      setClamped(false)
      return
    }
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1)
    measure()
    // A change in card width changes how many lines wrap into it (a pane's width keeps moving in the grid)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, item.result])
  /*
   * The tail of output while the tool is still running (#58, Codex's outputDelta). Only shown
   * until `result` arrives — unlike the preview, this shows **the end**: for a command still
   * running, what matters is now, not the start.
   * (The sum of chunks is not the whole thing — the first chunk has been observed missing in
   * practice. The full output is what `result` delivers.)
   */
  const liveTail =
    item.result === undefined && item.live
      ? item.live.replace(/\s+$/, '').split('\n').slice(-PREVIEW_LINES)
      : []

  return (
    <div className="rounded border border-edge bg-panel/60" data-testid="tool-card">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="tool-card-toggle"
      >
        {/* There must be one expand indicator across the whole app — the same chevron as the file tree */}
        <span className="shrink-0 text-slate">
          <ChevronIcon open={open} />
        </span>
        <span className="readout shrink-0 text-[11px] text-ash">{item.tool}</span>
        <span className="readout truncate text-[11px] text-slate">{item.title}</span>
        {item.ok === false && <span className="ml-auto shrink-0 text-[11px] text-chalk">Failed</span>}
      </button>

      {liveTail.length > 0 && (
        <div className="border-t border-edge px-2.5 py-1.5">
          <pre
            className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate ${PREVIEW_CLAMP}`}
            data-testid="tool-card-live"
          >
            {liveTail.join('\n')}
          </pre>
        </div>
      )}

      {lines.length > 0 && (
        <div className="border-t border-edge px-2.5 py-1.5">
          <pre
            ref={outRef}
            className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ash ${
              open ? '' : PREVIEW_CLAMP
            }`}
            data-testid="tool-card-output"
          >
            {open ? lines.join('\n') : lines.slice(0, PREVIEW_LINES).join('\n')}
          </pre>
          {!open && (hidden > 0 || clamped) && (
            <button
              className="readout mt-1 text-[10px] text-slate transition-colors hover:text-chalk"
              onClick={() => setOpen(true)}
              data-testid="tool-card-more"
            >
              {/* Only counted when lines can actually be counted — "N more lines" would be a
              lie for a blob with no newlines */}
              {hidden > 0 ? `${hidden} more lines` : 'Show all'}
            </button>
          )}
        </div>
      )}

      {launchesSubagent(item.tool) && item.callId && (
        <SubagentSteps sessionId={sessionId} callId={item.callId} projectRoot={projectRoot} projectId={projectId} />
      )}
    </div>
  )
}

/**
 * What the subagent a launch card started did (#222), collapsed under the card.
 *
 * The conversation never shows these steps: a subagent's calls landing among the parent's was
 * the confusion #98 removed. They are read from the host only when the person opens this, and
 * drawn with the conversation's own rows (`messagesToChat`, `ChatRow`) — its text, its reasoning,
 * its tool cards — so a step reads the same here as the parent's does above. An agent the
 * subagent launched is a launch card too, with its own steps inside.
 *
 * Whether it is open and what it read live in the store, keyed by the card: the virtual list
 * detaches a row that scrolls away, and a card drawn again must come back as it was left.
 */
function SubagentSteps({
  sessionId,
  callId,
  projectRoot,
  projectId,
}: {
  sessionId: string
  callId: string
  projectRoot: string | null
  projectId: string | null
}) {
  const steps = useStore((s) => s.subagentSteps[sessionId]?.[callId])
  const toggle = useStore((s) => s.toggleSubagentSteps)
  const loadMore = useStore((s) => s.loadMoreSubagentSteps)
  const rows = steps?.rows
  const items = useMemo(() => (rows ? messagesToChat(rows) : []), [rows])
  const open = !!steps?.open

  return (
    <div className="border-t border-edge" data-testid="subagent-steps">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left"
        onClick={() => toggle(sessionId, callId)}
        aria-expanded={open}
        data-testid="subagent-steps-toggle"
      >
        <span className="shrink-0 text-slate">
          <ChevronIcon open={open} />
        </span>
        <span className="readout text-[11px] text-slate">Subagent&apos;s steps</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-edge px-2.5 py-2" data-testid="subagent-steps-list">
          {items.map((it) => (
            <ChatRow key={it.seq} item={it} projectRoot={projectRoot} projectId={projectId} sessionId={sessionId} nested />
          ))}
          {steps?.loading && <p className="readout text-[11px] text-slate">Loading the steps…</p>}
          {steps?.error && (
            <p className="text-[11px] text-chalk" data-testid="subagent-steps-error">
              Could not load the steps — {steps.error}{' '}
              <button className="readout text-slate underline hover:text-chalk" onClick={() => void loadMore(sessionId, callId)}>
                Try again
              </button>
            </p>
          )}
          {steps && !steps.loading && !steps.error && items.length === 0 && (
            <p className="text-[11px] text-slate" data-testid="subagent-steps-empty">
              No steps were recorded for this agent. One that ran before Centralu kept them left only its report.
            </p>
          )}
          {steps?.more && !steps.loading && (
            <button
              className="readout self-start text-[10px] text-slate transition-colors hover:text-chalk"
              onClick={() => void loadMore(sessionId, callId)}
              data-testid="subagent-steps-more"
            >
              Show more steps
            </button>
          )}
        </div>
      )}
    </div>
  )
}
