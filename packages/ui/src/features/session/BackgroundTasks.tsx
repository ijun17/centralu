import { useEffect, useRef, useState, type ReactNode } from 'react'
import { backgroundCount } from '@cc/core'
import type { BackgroundTask } from '@cc/protocol'
import { ChevronIcon } from '../../components/icons.jsx'
import { useStore } from '../../store/store.js'

/**
 * A session's background work, on screen (#290).
 *
 * On 2026-10-04 two background subagents stopped when the person interrupted the turn to rephrase a message, and
 * nothing on screen said they were gone; it took four hours for anyone to notice. So what runs behind the turn is
 * counted where the session is named (the header, the sidebar row, the control rail), and the list it opens keeps a
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
  const rootRef = useRef<HTMLSpanElement>(null)
  const count = backgroundCount(tasks)
  const ended = tasks.filter((t) => t.status !== 'running')
  const shown = count > 0 || ended.length > 0

  // Closes on an outside click or Esc, like the session settings menu — an open list must not wall off the header
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
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
    <span className="relative flex shrink-0 items-center" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="background-badge"
        data-count={count}
        title={count > 0 ? `${count} background task${count === 1 ? '' : 's'} running — open the list` : 'Background tasks that ended — open the list'}
        className={`readout flex shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors hover:text-chalk ${
          count > 0 ? 'border-ash text-ash' : 'border-edge text-slate'
        }`}
      >
        {count > 0 && <span className="size-1.5 animate-pulse rounded-full bg-chalk" aria-hidden />}
        {badgeText(tasks)}
        <ChevronIcon open={open} size={9} />
      </button>
      {open && (
        <BackgroundTaskList sessionId={sessionId} tasks={tasks} renderSteps={renderSteps} />
      )}
    </span>
  )
}

function BackgroundTaskList({
  sessionId,
  tasks,
  renderSteps,
}: {
  sessionId: string
  tasks: readonly BackgroundTask[]
  renderSteps?: (callId: string) => ReactNode
}) {
  const clear = useStore((s) => s.clearBackgroundTasks)
  const hasEnded = tasks.some((t) => t.status !== 'running')
  return (
    <div
      role="dialog"
      aria-label="Background tasks"
      data-testid="background-list"
      className="absolute left-0 top-full z-30 mt-1 max-h-96 w-96 max-w-[80vw] overflow-y-auto rounded border border-edge bg-panel shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
    >
      <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1.5">
        <span className="text-[11px] text-ash">Background tasks</span>
        {hasEnded && (
          <button
            type="button"
            className="readout ml-auto text-[10px] text-slate transition-colors hover:text-chalk"
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
    <li className="border-b border-edge px-2.5 py-1.5 last:border-b-0" data-testid={`background-task-${task.id}`} data-status={task.status}>
      <div className="flex items-baseline gap-2">
        <span className="readout shrink-0 text-[10px] text-slate">{KIND[task.kind]}</span>
        <span className={`min-w-0 flex-1 truncate text-[11px] ${running ? 'text-chalk' : 'text-ash'}`} title={task.description}>
          {task.description}
        </span>
        <span className="readout shrink-0 text-[10px] text-slate" data-testid={`background-status-${task.id}`}>
          {task.ambient && running ? 'ambient' : STATUS[task.status]}
        </span>
        {running && task.stoppable && (
          <button
            type="button"
            className="shrink-0 rounded border border-edge px-1.5 text-[10px] text-slate transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
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
        <p className="mt-0.5 line-clamp-2 text-[10px] text-slate" data-testid={`background-note-${task.id}`}>
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
 * The same count as a small mark, for a row that names the session elsewhere (the sidebar, the control rail).
 * Nothing when nothing runs: an ended task is the session's own business, read in its header.
 */
export function BackgroundMark({ tasks, testId }: { tasks: readonly BackgroundTask[]; testId: string }) {
  const n = backgroundCount(tasks)
  if (n === 0) return null
  return (
    <span
      className="readout shrink-0 rounded border border-edge px-1 text-[9px] leading-relaxed text-slate"
      data-testid={testId}
      title={`${n} background task${n === 1 ? '' : 's'} running`}
    >
      {n} bg
    </span>
  )
}
