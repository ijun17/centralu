import { taskKey, type TaskGroups } from '@cc/core'
import type { MailTaskRow } from '@cc/protocol/client'
import { Badge } from '../../components/Badge.jsx'
import { RelativeAge } from '../../components/RelativeAge.js'
import { FoldedGroup } from './FoldedGroup.jsx'
import { People } from './MailRows.jsx'
import { taskStateLabel } from './mailLabels.js'

/**
 * The Inbox's Tasks (#1577, owner 2026-11-14): the host's work grouped by who acts next (`groupTasks`), a group drawn only while it has a row, Done
 * folded. A row opens its chain in the Inbox's thread view; one between sessions opens read-only (`MailThreadView.lookIn`). The keys walk the rows
 * as they walk Waiting's (`Inbox`), so the row under the cursor is named by `cursor`.
 */
export function TaskList({
  groups: g,
  cursor,
  doneOpen,
  onToggleDone,
  onOpen,
}: {
  groups: TaskGroups
  cursor: string | null
  doneOpen: boolean
  onToggleDone: () => void
  /** What a row does when pressed: its chain, or Waiting's held row for a held one (`Inbox`) */
  onOpen: (t: MailTaskRow) => void
}) {
  const parts = [
    { title: 'Needs you', rows: g.needsYou, testId: 'needs-you' },
    { title: 'Waiting on others', rows: g.waitingOnOthers, testId: 'waiting-on-others' },
    { title: 'Unassigned', rows: g.unassigned, testId: 'unassigned' },
  ].filter((p) => p.rows.length > 0)
  if (parts.length === 0 && g.done.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-md text-ink-muted" data-testid="inbox-tasks-empty">
        No tasks
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="inbox-tasks">
      {parts.map((p) => (
        <section key={p.testId} aria-label={p.title} data-testid={`tasks-${p.testId}`}>
          <h3 className="flex items-baseline gap-1.5 px-4 pb-0.5 pt-2.5">
            <Badge>{p.title}</Badge>
            <Badge readout>{p.rows.length}</Badge>
          </h3>
          <ul className="flex flex-col gap-0.5 p-1">
            {p.rows.map((t) => (
              <TaskRow key={taskKey(t)} task={t} active={taskKey(t) === cursor} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
      {g.done.length > 0 && (
        <FoldedGroup label="Done" count={g.done.length} open={doneOpen} onToggle={onToggleDone} testId="tasks-done">
          {g.done.map((t) => (
            <TaskRow key={taskKey(t)} task={t} active={taskKey(t) === cursor} onOpen={onOpen} dim />
          ))}
        </FoldedGroup>
      )}
    </div>
  )
}

/** One task: its subject, who gave it to whom with the live dot of the one who has it, its state and when it last moved */
function TaskRow({ task: t, active, onOpen, dim }: { task: MailTaskRow; active: boolean; onOpen: (t: MailTaskRow) => void; dim?: boolean }) {
  const key = taskKey(t)
  return (
    <li data-cursor={active || undefined} className={`rounded-field transition-colors ${active ? 'bg-surface-hover/50' : 'hover:bg-surface-hover/25'} ${dim ? 'opacity-80' : ''}`}>
      <button className="flex w-full min-w-0 items-center gap-2.5 py-2 pl-3 pr-3 text-left" onClick={() => onOpen(t)} data-testid={`task-${key}`}>
        <span className="min-w-0 truncate text-md text-ink">{t.subject}</span>
        <People owner={t.owner} assignee={t.assignee} />
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="text-xs text-ink-faint" data-testid={`task-state-${key}`}>
            {taskStateLabel(t)}
          </span>
          <span className="readout w-12 text-right text-xs text-ink-faint">
            <RelativeAge when={t.updatedAt} />
          </span>
        </span>
      </button>
    </li>
  )
}
