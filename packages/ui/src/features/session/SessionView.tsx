import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode, RefObject } from 'react'
import { shouldMarkRead } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { Kbd } from '../../components/primitives.jsx'
import { useSessionAway, useSessionFolder } from '../../store/selectors.js'
import { lazyComponent } from '../../components/lazy.jsx'
import { usePresence } from '../../components/presence.js'
import { isFileDrag } from '../files/dragPath.js'
import { APP_LINK_DROP_EVENT, type AppLinkDrop } from '../app-frame/dragRelay.js'
import { isOutsideLink } from './dragLink.js'
import { ChatStream } from './chat-stream/ChatStream.jsx'
import { SessionStart } from './SessionStart.jsx'
import { Composer, type ComposerDrop } from './Composer.jsx'
import { SessionHeader } from './SessionHeader.jsx'
import { AwayNote, DormantNote, StopNote, useSessionNotes } from './SessionNotes.jsx'
import { EMPTY_CHAT } from './empty.js'
import { UntrustedNotice } from '../project/UntrustedNotice.jsx'
import { COMPOSER_REACH } from './foldedComposer.js'

/**
 * The composer's resting height as a share of the panel that folds it (docs/design-system.md §7): a
 * share, so a larger text size folds sooner. Unfolding waits for 16% so a slow drag does not flip
 * at every pixel; the folded card's own border widens the band (folds below ~570px, opens above ~620px).
 */
const FOLD_SHARE = 1 / 6
const UNFOLD_SHARE = 0.16

/** The fold's own `duration-300`, `.cc-composer-rise` */
const RISE_MS = 300

/** Brings xterm, so loaded on first open */
const CommandRunnerOverlay = lazyComponent(() =>
  import('./CommandRunner.jsx').then((m) => m.CommandRunnerOverlay),
)

/** The focus view: one session at full width, drawn by the SessionPane grid cells use too */
export function SessionView() {
  const session = useFocusedSession()
  // Nothing until the first lists arrive (owner, 2026-10-18): the session being restored may be about to open
  const listed = useStore((s) => s.connection === 'connected' || Object.keys(s.sessions).length > 0)

  if (!session) {
    if (!listed) return <div className="flex-1" data-testid="empty-focus-waiting" />
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

/** One session's screen, for the focus view and the grid alike, so both read one store */
export function SessionPane({
  sessionId,
  headerExtra,
  headerDrag,
  foldWhenShort = false,
}: {
  sessionId: string
  /** In the header's row (the grid's dismiss), so it aligns with the header's own buttons */
  headerExtra?: ReactNode
  /** The grid and the project screen: the composer folds in a short pane (`FOLD_SHARE`) */
  foldWhenShort?: boolean
  /** The grid's: the header moves the pane, where in the focus view it is the title bar */
  headerDrag?: (e: DragEvent<HTMLElement>) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const chat = useStore((s) => s.chat[sessionId] ?? EMPTY_CHAT)
  // Paths resolve against this session's folder or worktree (#39, #1209), not the focused one's;
  // the Assistant gets null, so its messages link nowhere (`parseFileRef`)
  const projectRoot = useSessionFolder(sessionId)
  const markRead = useStore((s) => s.markRead)

  // Held here, not in the menu (#44): in the grid the `draggable` header would drag the panel on a menu press
  const [runOpen, setRunOpen] = useState(false)
  const runPresence = usePresence(runOpen)
  const scrollRef = useRef<HTMLDivElement>(null)
  // What raises a folded card, any of them: a hand at the bottom strip or over the raised card
  // (which reaches above the strip), focus in it, its menu, a drop that landed (#116)
  const [nearComposer, setNearComposer] = useState(false)
  const [overComposer, setOverComposer] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [composerMenu, setComposerMenu] = useState(false)
  const [droppedIn, setDroppedIn] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const composerDrop = useRef<ComposerDrop>(null)
  // A drag out of an app view arrives as an event, not a drop (#308): a page never hears another
  // origin's drag (app-frame/dragRelay.ts)
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
  const composerRef = useRef<HTMLDivElement>(null)
  // On a linked machine that is away (#82): nothing here tries to wake it
  const away = useSessionAway(sessionId)
  const notes = useSessionNotes(session, away)
  // Not while a note with a button shows (docs/design-system.md §7)
  const short = useShortPane(foldWhenShort, paneRef, composerRef, notes.hasButton)
  const fold = short && !notes.hasButton
  // Opening slides the card up (design-system §9), decided in render so the first open frame has it below the edge
  const [prevFold, setPrevFold] = useState(fold)
  const [rising, setRising] = useState(false)
  if (prevFold !== fold) {
    setPrevFold(fold)
    // A raised card is already in its place
    const raised = nearComposer || overComposer || composerFocused || composerMenu || droppedIn
    setRising(!fold && !raised && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }
  useEffect(() => {
    if (!rising) return
    const t = setTimeout(() => setRising(false), RISE_MS)
    return () => clearTimeout(t)
  }, [rising])
  const composerUp = !fold || nearComposer || overComposer || composerFocused || composerMenu || droppedIn

  // Measured, as attachments and up to five lines change it; the space under the conversation
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
  // The pane fetches what it shows (the grid shows without selecting). Loaded means a history
  // cursor (#79): rows can come from an event first
  const loaded = useStore((s) => !!s.history[sessionId])
  useEffect(() => {
    if (!loaded) void loadHistory(sessionId)
  }, [sessionId, loaded, loadHistory])

  // Read only while the app is in front (#161), as `turn_complete`'s notification and `Notices` judge seen;
  // coming back restarts the 3 seconds
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

  // An app's agent session is opened the moment it shows (#378): a short run is deleted inside 3 seconds
  const markOpened = useStore((s) => s.markOpened)
  const sessionShownId = session?.id
  const shownAppSession = !!session?.appId
  useEffect(() => {
    if (sessionShownId && shownAppSession && appFocused) void markOpened(sessionShownId)
  }, [sessionShownId, shownAppSession, appFocused, markOpened])

  if (!session) return null

  // A brand-new session offers the other tool and past conversations to resume
  const starting =
    !!session &&
    session.kind === 'worker' &&
    !!session.projectId &&
    !session.appId &&
    session.lastSeq === 0 &&
    chat.length === 0

  return (
    // min-h-0: a flex child's min-height is auto, so a long conversation would push the composer out of a grid cell
    <section
      /*
       * Clip, not hidden: a hidden box is still a scroll container, and focusing the folded input
       * scrolled the pane 85px up, header gone and the pressed button's mouseup lost.
       */
      ref={paneRef}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-floor ${fold || rising ? 'overflow-clip' : ''}`}
      data-testid="session-view"
      // By coordinates: a transparent strip would take selecting and links from that area
      onMouseMove={
        foldWhenShort
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setNearComposer(e.clientY > r.bottom - COMPOSER_REACH)
            }
          : undefined
      }
      onMouseLeave={
        foldWhenShort
          ? () => {
              setNearComposer(false)
              setDroppedIn(false)
            }
          : undefined
      }
      // The whole pane takes a drop (#116), for its own session: a folded composer is out of sight
      onDragOver={(e) => {
        // Reordering is someone else's; a link from outside the window is taken like a file (#308)
        if (!isFileDrag(e.dataTransfer.types) && !isOutsideLink(e.dataTransfer.types)) return
        /*
         * Over the composer, the highlight is its own, and one place lights, not two. Turned off
         * here, as onto the composer is no dragleave of the pane. Not `defaultPrevented`: App.tsx's
         * floor guard already prevented every drag in the capture phase.
         */
        if (composerRef.current?.contains(e.target as Node)) {
          setDragOver(false)
          return
        }
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!isFileDrag(e.dataTransfer.types) && !isOutsideLink(e.dataTransfer.types)) return
        setDragOver(false)
        // The composer took its own drop already
        if (composerRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        void composerDrop.current?.accept(e.dataTransfer).then((landed) => {
          if (landed) setDroppedIn(true)
        })
      }}
    >
      {/* The composer's drop border, pane-sized (#116);
          under the raised card (z-20) */}
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
        stop={notes.stop}
      />

      {/* Outside the composer, whose height decides the fold */}
      <UntrustedNotice projectId={session.projectId} className="shrink-0 border-b border-line-chrome px-4 py-1.5" />

      {starting && session?.projectId && (
        <SessionStart sessionId={sessionId} projectId={session.projectId} tool={session.tool} />
      )}
      <ChatStream
        yieldSpace={starting}
        bottomPeek={fold}
        // Always the card's full height, so its rise never moves the conversation (docs/design-system.md §7)
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

      {/* No process (FR-10): said before the person writes,
          not as a failure after */}
      {away ? <AwayNote machine={session.machine ?? null} /> : notes.dormant && <DormantNote sessionId={session.id} />}

      {/* Why the last turn stopped (#698, #1415); the state alone
          looks like a turn that ended */}
      <StopNote key={session.id} sessionId={session.id} stop={notes.stop} />

      {/* Folded: absolutely placed over the reserved space
          (docs/design-system.md §7) */}
      <div
        className={
          fold
            ? // Bottom corners on the pane's clip curve: its radius less its 1px border
              `absolute inset-x-0 bottom-0 z-20 rounded-t-lg rounded-b-[calc(var(--radius-lg)-1px)] border border-line bg-surface-floor px-1 pt-1 transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
                composerUp
                  ? // Cast far (25px) to part the card from the text it covers; tuned over the #1d1d1d floor (it bottoms out at 12 there)
                    'translate-y-0 shadow-(--shadow-dock-raised)'
                  : // Moved, not resized, so composerH and the fold shares read the same height
                    'translate-y-full shadow-none'
              }`
            : rising
              ? 'cc-composer-rise'
              : undefined
        }
        ref={composerRef}
        data-testid="composer-shell"
        data-up={fold ? composerUp || undefined : undefined}
        // Followed when open too: a card that folds under a resize while in use stays up
        onMouseEnter={() => setOverComposer(true)}
        onMouseLeave={() => setOverComposer(false)}
        onFocusCapture={() => setComposerFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setComposerFocused(false)
        }}
      >
        <Composer
          sessionId={session.id}
          framed={!fold}
          onMenuOpenChange={setComposerMenu}
          dropRef={composerDrop}
        />
      </div>

      {/* The commands window (#60),
          the pane's size */}
      {runPresence.shown && session.projectId && (
        <CommandRunnerOverlay
          projectId={session.projectId}
          sessionId={session.id}
          leaving={runPresence.leaving}
          onClose={() => setRunOpen(false)}
        />
      )}
    </section>
  )
}

/** From the pane, not the window; both heights in layout pixels, so the text size's zoom cancels out */
function useShortPane(
  enabled: boolean,
  paneRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLDivElement | null>,
  held: boolean,
): boolean {
  const [short, setShort] = useState(false)
  useLayoutEffect(() => {
    const pane = paneRef.current
    const shell = composerRef.current
    if (!enabled || !pane || !shell) {
      setShort(false)
      return
    }
    // A note holds it open: the open card measures shorter than the folded one, so the last answer stands
    if (held) return
    const measure = () => {
      const paneH = pane.offsetHeight
      const restH = restingHeight(shell)
      if (paneH <= 0 || restH <= 0) return
      const share = restH / paneH
      setShort((was) => (was ? share > UNFOLD_SHARE : share > FOLD_SHARE))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(pane)
    ro.observe(shell)
    return () => ro.disconnect()
  }, [enabled, held, paneRef, composerRef])
  return enabled && short
}

/**
 * The composer at rest (#2190): the card at one line with its footer. A long draft and the rows above
 * the card (attachments, a notice) come and go with the person's work, so they must not fold it.
 */
function restingHeight(shell: HTMLElement): number {
  const card = shell.querySelector<HTMLElement>('[data-composer-card]')
  const input = card?.querySelector('textarea')
  const first = card?.parentElement?.firstElementChild
  if (!card || !input || !(first instanceof HTMLElement)) return shell.offsetHeight
  const line = Math.max(22, parseFloat(getComputedStyle(input).lineHeight) || 0)
  return shell.offsetHeight - (card.offsetTop - first.offsetTop) - Math.max(0, input.offsetHeight - line)
}
