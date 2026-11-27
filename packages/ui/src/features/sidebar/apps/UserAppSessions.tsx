import { isMirrored, isUnread, type SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { SESSION_MIME } from '../reorder.js'
import { INDENT, GUIDE, ROW_PAD, ROW_PAD_IDLE } from '../layout.js'
import { ToolMark } from '../marks/ToolMark.jsx'

/**
 * A user-folder app's sessions (its builder, its `run_agent` agents): their one row, as they have no project and can
 * still wait on the person. A project-less session no listed app claims has no row; search, palette and inbox reach it.
 */
export function UserAppSessions({ sessions: own }: { sessions: SessionSummary[] }) {
  const selected = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const machines = useStore((s) => s.machines)
  return own.map((s) => {
    const focused = selected === s.id
    const unread = isUnread(s)
    return (
      <li
        key={s.id}
        data-level={2}
        className={`relative ${INDENT[2]} pr-1.5 ${GUIDE}`}
        // Onto the grid like any session row; it carries no project, so no project screen takes it
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SESSION_MIME, s.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        <button
          type="button"
          onClick={() => focusSession(s.id)}
          data-testid={`app-session-row-${s.id}`}
          aria-current={focused ? 'page' : undefined}
          data-unread={(unread && !focused) || undefined}
          className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-md transition-colors ${
            focused
              ? `rounded-r-md border-l-2 border-l-ink-muted bg-surface-hover/40 ${ROW_PAD} text-ink`
              : `rounded-md ${ROW_PAD_IDLE} text-ink-muted hover:bg-surface-hover/25 hover:text-ink hover:ring-1 hover:ring-inset hover:ring-line`
          }`}
        >
          <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !isMirrored(s, machines)} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} unread={isUnread(s)} />
          <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
        </button>
      </li>
    )
  })
}
