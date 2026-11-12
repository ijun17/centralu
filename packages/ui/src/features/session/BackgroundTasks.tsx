import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { backgroundCount } from '@cc/core'
import type { BackgroundTask } from '@cc/protocol/client'
import { useAnchoredPlacement } from '../../components/anchored.js'
import { useDismiss } from '../../components/useDismiss.js'
import { BackgroundIcon, StopIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Tooltip } from '../../components/primitives.jsx'
import { usePresence } from '../../components/presence.js'
import { useStore } from '../../store/store.js'

/**
 * A session's background work, on screen (#290).
 *
 * On 2026-10-04 two background subagents stopped when the person interrupted the turn to rephrase a message, and
 * nothing on screen said they were gone; it took four hours for anyone to notice. So what runs behind the turn is
 * counted where the session is named (the header, the sidebar row), and the list it opens keeps a
 * task that ended — stopped, failed or completed — with how it ended, for as long as one still runs. When the last one ends
 * the badge goes with the list (owner, 2026-11-12, #2213), and what ended is in the conversation.
 *
 * The count leaves out what the tool calls ambient (housekeeping, not activity), and ended tasks: it answers "is
 * something still running back there".
 */

const KIND: Record<BackgroundTask['kind'], string> = {
  agent: 'agent',
  shell: 'shell',
  mcp: 'mcp',
  other: 'task',
}
const STATUS: Record<BackgroundTask['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/**
 * What the list's header counts: the tasks running, by the same rule as the capsule's number (ambient ones are left
 * out). The list is only open while work runs (#2213). The header used to count every running row, so a session with one real
 * and one ambient task said "1" on the capsule and "2 running" in the list (#1143 U25).
 */
export function listCount(tasks: readonly BackgroundTask[]): string {
  return `${backgroundCount(tasks)} running`
}

/**
 * The header's count, and the list it opens. Drawn only while work runs behind the turn (owner, 2026-11-12, #2213): a running
 * task that is activity. When the last one ends it fades out, with the count it had, and the ended ones it listed go with it.
 *
 * `renderSteps` draws an agent's recorded steps (#222) under its row — the same record its launch card opens in the
 * conversation.
 */
export function BackgroundTasksBadge({
  sessionId,
  tasks,
  renderSteps,
}: {
  sessionId: string
  tasks: readonly BackgroundTask[]
  renderSteps?: (callId: string) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const running = backgroundCount(tasks) > 0
  // What it showed while work ran, for its exit: once nothing runs there is nothing to say, so it goes as it was and does not turn into a record
  const [last, setLast] = useState(tasks)
  if (running && last !== tasks) setLast(tasks)
  const shownTasks = running ? tasks : last
  const count = backgroundCount(shownTasks)

  /*
   * Closes on an outside click, Esc or the window losing focus (useDismiss), like the session settings menu — an open
   * list must not wall off the header. "Outside" is outside both the button and the list: the list is not inside the
   * button's box in the DOM any more.
   */
  useDismiss({ open, onClose: () => setOpen(false), refs: [buttonRef, listRef], returnFocusTo: buttonRef })
  // The last one ended: nothing left to hold open
  useEffect(() => {
    if (!running) setOpen(false)
  }, [running])

  // The capsule fades in and out, and the list comes down from it and goes back up (usePresence keeps each for its exit)
  const capsule = usePresence(running)
  const { shown: listShown, leaving } = usePresence(open)

  if (!capsule.shown) return null
  return (
    <span className={`${capsule.leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} flex shrink-0 items-center`}>
      {/*
        The top bar's capsule shape (owner, 2026-10-18): an icon and a number, the words in the tooltip. Running work
        has the plain hairline (owner, twice: a brighter border stood out too much) and brighter ink with its count; no
        dot (owner, 2026-10-18: it drew the eye to something that needs nothing). Nothing is drawn once no work runs.
      */}
      <Tooltip
        align="right"
        content={
          <span className="block">
            <span className="block text-ink">
              {`${count} background task${count === 1 ? '' : 's'} running`}
            </span>
            <span className="mt-1 block text-ink-faint">Open the list to follow or stop them</span>
          </span>
        }
      >
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${count} background`}
          onClick={() => setOpen((o) => !o)}
          data-testid="background-badge"
          data-count={count}
          className={`flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-hover/30 px-2 text-ink transition-colors hover:bg-surface-hover/60 hover:text-ink ${open ? 'bg-surface-hover/60' : ''}`}
        >
          <BackgroundIcon />
          <span className="readout translate-y-px text-xs leading-none">{count}</span>
        </button>
      </Tooltip>
      {/*
        In body, not under the button: a grid panel is overflow-hidden, and a list hung off the header as an absolute
        child lost its right side — Stop included — to the panel's edge (anchored.ts).
      */}
      {listShown &&
        createPortal(
          <BackgroundTaskList
            sessionId={sessionId}
            tasks={shownTasks}
            renderSteps={renderSteps}
            anchorRef={buttonRef}
            listRef={listRef}
            leaving={leaving}
          />,
          document.body,
        )}
    </span>
  )
}

function BackgroundTaskList({
  sessionId,
  tasks,
  renderSteps,
  anchorRef,
  listRef,
  leaving = false,
}: {
  sessionId: string
  tasks: readonly BackgroundTask[]
  renderSteps?: (callId: string) => ReactNode
  anchorRef: RefObject<HTMLElement | null>
  listRef: RefObject<HTMLDivElement | null>
  /** Closing: the exit animation plays and presses pass through */
  leaving?: boolean
}) {
  const clear = useStore((s) => s.clearBackgroundTasks)
  const hasEnded = tasks.some((t) => t.status !== 'running')
  const at = useAnchoredPlacement(anchorRef, listRef, true)
  return (
    <div
      ref={listRef}
      role="dialog"
      aria-label="Background tasks"
      data-testid="background-list"
      /*
        The width gives way to a window narrower than the list (vw divided by the zoom, as in Modal — vw does not know
        about it), and the title in each row is what truncates, so the status and Stop always have their room.
      */
      className={`fixed z-40 w-[420px] max-w-[calc(100vw/var(--text-zoom)_-_1rem)] overflow-y-auto rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) ${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'}`}
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        maxHeight: at ? `min(24rem, ${at.maxHeight}px)` : '24rem',
        visibility: at ? 'visible' : 'hidden',
      }}
    >
      {/* The inbox's and usage's dropdown shape (owner, 2026-10-18): a title, its count, one quiet action */}
      <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Background</h2>
        <span className="readout text-xs text-ink-faint">
          {listCount(tasks)}
        </span>
        {hasEnded && (
          <button
            type="button"
            className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink"
            onClick={() => void clear(sessionId)}
            data-testid="background-clear"
          >
            Clear ended
          </button>
        )}
      </header>
      <ul className="flex flex-col py-1">
        {tasks.map((t) => (
          <BackgroundTaskRow key={t.id} sessionId={sessionId} task={t} renderSteps={renderSteps} />
        ))}
      </ul>
    </div>
  )
}

function BackgroundTaskRow({
  sessionId,
  task,
  renderSteps,
}: {
  sessionId: string
  task: BackgroundTask
  renderSteps?: (callId: string) => ReactNode
}) {
  const stop = useStore((s) => s.stopBackgroundTask)
  const [stopping, setStopping] = useState(false)
  const running = task.status === 'running'
  // The record an agent's launch card opens (#222). Only an agent has one; a shell's output is its own card's
  const record = task.kind === 'agent' && task.parentCallId && renderSteps ? task.parentCallId : null
  /*
   * What Stop on the turn would do to it, as measured for its tool — the same fact the Stop control sums up. Said per
   * row too, because a list where some rows survive Stop and some do not reads the same at a glance otherwise.
   */
  const withTurn = !running
    ? null
    : task.stopsWithTurn === true
      ? 'stops with the turn'
      : task.stopsWithTurn === false
        ? 'survives Stop'
        : null
  return (
    <li
      className="px-4 py-2 transition-colors hover:bg-surface-hover/20"
      data-testid={`background-task-${task.id}`}
      data-status={task.status}
    >
      <div className="flex items-center gap-2.5">
        {/*
          The task's state as a mark, the capsule's grammar: a steady white dot while it runs, a hollow ring once done,
          a dashed ring when it failed or was stopped.
        */}
        <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
          {running ? (
            <span className="size-1.5 rounded-full bg-ink-signal" />
          ) : task.status === 'completed' ? (
            <span className="size-2 rounded-full border border-ink-faint" />
          ) : (
            <span className="size-2 rounded-full border border-dashed border-ink-muted" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm leading-snug ${running ? 'text-ink' : 'text-ink-muted'}`}
            title={task.description}
            data-testid={`background-title-${task.id}`}
          >
            {task.description}
          </span>
          <span className="readout mt-0.5 block truncate text-2xs text-ink-faint">
            {KIND[task.kind]} ·{' '}
            <span data-testid={`background-status-${task.id}`}>
              {task.ambient && running ? 'ambient' : STATUS[task.status]}
            </span>
            {withTurn && <span data-testid={`background-note-${task.id}`}> · {withTurn}</span>}
          </span>
        </span>
        {running && task.stoppable && (
          <IconButton
            label={stopping ? 'Stopping…' : 'Stop this task'}
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void stop(sessionId, task.id).finally(() => setStopping(false))
            }}
            testId={`background-stop-${task.id}`}
            align="right"
          >
            <StopIcon />
          </IconButton>
        )}
      </div>
      {!running && task.summary && task.summary !== task.description && (
        <p
          className="mt-1 line-clamp-2 pl-[22px] text-2xs leading-body text-ink-faint"
          data-testid={`background-note-${task.id}`}
        >
          {task.summary}
        </p>
      )}
      {record && (
        <div className="-mx-4 mt-1" data-testid={`background-steps-${task.id}`}>
          {renderSteps!(record)}
        </div>
      )}
    </li>
  )
}

/**
 * What the sidebar row's tool mark says of background work (#290): how many tasks run and what they are, or null when
 * nothing runs (an ended task is the session's own business, read in its conversation). The mark's dot shows that something
 * runs; this is its words.
 *
 * It names what runs, and that it keeps the session awake (#568): a session whose process holds work, a `/loop`
 * wake-up or a scheduled prompt among it, is not put to sleep, and a person who wonders why it still holds its
 * process finds the answer here.
 */
export function backgroundNote(tasks: readonly BackgroundTask[]): { summary: string; running: string[] } | null {
  const n = backgroundCount(tasks)
  if (n === 0) return null
  return {
    summary: `${n} background task${n === 1 ? '' : 's'} running (keeps the session awake)`,
    running: tasks.filter((t) => t.status === 'running' && !t.ambient).map((t) => `· ${t.description}`),
  }
}
