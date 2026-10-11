import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isPlainEscape } from '../../app/keys.js'
import { createPortal } from 'react-dom'
import { backgroundCount } from '@cc/core'
import type { BackgroundTask } from '@cc/protocol'
import { useAnchoredPlacement } from '../../components/anchored.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { useStore } from '../../store/store.js'

/**
 * A session's background work, on screen (#290).
 *
 * On 2026-10-04 two background subagents stopped when the person interrupted the turn to rephrase a message, and
 * nothing on screen said they were gone; it took four hours for anyone to notice. So what runs behind the turn is
 * counted where the session is named (the header, the sidebar row), and the list it opens keeps a
 * task that ended — stopped, failed or completed — with how it ended, until the person clears it.
 *
 * The count leaves out what the tool calls ambient (housekeeping, not activity), and ended tasks: it answers "is
 * something still running back there".
 */

const KIND: Record<BackgroundTask['kind'], string> = { agent: 'agent', shell: 'shell', mcp: 'mcp', other: 'task' }
const STATUS: Record<BackgroundTask['status'], string> = { running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' }

/** What the badge says: the running count, or — once nothing runs — how the listed ones ended */
function badgeText(tasks: readonly BackgroundTask[]): string {
  const n = backgroundCount(tasks)
  if (n > 0) return `${n} background`
  const failed = tasks.filter((t) => t.status === 'failed').length
  const stopped = tasks.filter((t) => t.status === 'stopped').length
  const parts = [failed > 0 && `${failed} failed`, stopped > 0 && `${stopped} stopped`].filter(Boolean)
  return `background · ${parts.length > 0 ? parts.join(' · ') : 'done'}`
}

/**
 * The header's count, and the list it opens. Drawn only while there is something to show: a running task that is
 * activity, or an ended one still listed.
 *
 * `renderSteps` draws an agent's recorded steps (#222) under its row — the same record its launch card opens in the
 * conversation, so a stopped agent's last steps are one click from the list that says it stopped.
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
  const count = backgroundCount(tasks)
  const ended = tasks.filter((t) => t.status !== 'running')
  const shown = count > 0 || ended.length > 0

  /*
   * Closes on an outside click or Esc, like the session settings menu — an open list must not wall off the header.
   * "Outside" is outside both the button and the list: the list is not inside the button's box in the DOM any more.
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!buttonRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  // The last one cleared — nothing left to hold open
  useEffect(() => {
    if (!shown) setOpen(false)
  }, [shown])

  if (!shown) return null
  return (
    <span className="flex shrink-0 items-center">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="background-badge"
        data-count={count}
        title={count > 0 ? `${count} background task${count === 1 ? '' : 's'} running — open the list` : 'Background tasks that ended — open the list'}
        className={`readout flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-2xs transition-colors hover:text-ink ${
          count > 0 ? 'border-ink-muted text-ink-muted' : 'border-line text-ink-faint'
        }`}
      >
        {count > 0 && <span className="size-1.5 animate-pulse rounded-full bg-ink" aria-hidden />}
        {badgeText(tasks)}
        <ChevronIcon open={open} size={9} />
      </button>
      {/*
        In body, not under the button: a grid panel is overflow-hidden, and a list hung off the header as an absolute
        child lost its right side — Stop included — to the panel's edge (anchored.ts).
      */}
      {open &&
        createPortal(
          <BackgroundTaskList
            sessionId={sessionId}
            tasks={tasks}
            renderSteps={renderSteps}
            anchorRef={buttonRef}
            listRef={listRef}
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
}: {
  sessionId: string
  tasks: readonly BackgroundTask[]
  renderSteps?: (callId: string) => ReactNode
  anchorRef: RefObject<HTMLElement | null>
  listRef: RefObject<HTMLDivElement | null>
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
      className="fixed z-40 w-96 max-w-[calc(100vw/var(--text-zoom)_-_1rem)] overflow-y-auto rounded-md border border-line bg-surface-raised shadow-(--shadow-popover)"
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        maxHeight: at ? `min(24rem, ${at.maxHeight}px)` : '24rem',
        visibility: at ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <span className="text-xs text-ink-muted">Background tasks</span>
        {hasEnded && (
          <button
            type="button"
            className="readout ml-auto text-2xs text-ink-faint transition-colors hover:text-ink"
            onClick={() => void clear(sessionId)}
            data-testid="background-clear"
          >
            Clear ended
          </button>
        )}
      </div>
      <ul className="flex flex-col">
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
  const withTurn = !running ? null : task.stopsWithTurn === true ? 'stops with the turn' : task.stopsWithTurn === false ? 'survives Stop' : null
  return (
    <li className="border-b border-line px-2.5 py-1.5 last:border-b-0" data-testid={`background-task-${task.id}`} data-status={task.status}>
      <div className="flex items-baseline gap-2">
        <span className="readout shrink-0 text-2xs text-ink-faint">{KIND[task.kind]}</span>
        <span
          className={`min-w-0 flex-1 truncate text-xs ${running ? 'text-ink' : 'text-ink-muted'}`}
          title={task.description}
          data-testid={`background-title-${task.id}`}
        >
          {task.description}
        </span>
        <span className="readout shrink-0 text-2xs text-ink-faint" data-testid={`background-status-${task.id}`}>
          {task.ambient && running ? 'ambient' : STATUS[task.status]}
        </span>
        {running && task.stoppable && (
          <button
            type="button"
            className="shrink-0 rounded-md border border-line px-1.5 text-2xs text-ink-faint transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void stop(sessionId, task.id).finally(() => setStopping(false))
            }}
            data-testid={`background-stop-${task.id}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {(withTurn || (!running && task.summary && task.summary !== task.description)) && (
        <p className="mt-0.5 line-clamp-2 text-2xs text-ink-faint" data-testid={`background-note-${task.id}`}>
          {withTurn ?? task.summary}
        </p>
      )}
      {record && (
        <div className="-mx-2.5 mt-1" data-testid={`background-steps-${task.id}`}>
          {renderSteps!(record)}
        </div>
      )}
    </li>
  )
}

/**
 * The same count as a small mark, for a row that names the session elsewhere (the sidebar).
 * Nothing when nothing runs: an ended task is the session's own business, read in its header.
 */
export function BackgroundMark({ tasks, testId }: { tasks: readonly BackgroundTask[]; testId: string }) {
  const n = backgroundCount(tasks)
  if (n === 0) return null
  return (
    <span
      className="readout shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
      data-testid={testId}
      title={`${n} background task${n === 1 ? '' : 's'} running`}
    >
      {n} bg
    </span>
  )
}
