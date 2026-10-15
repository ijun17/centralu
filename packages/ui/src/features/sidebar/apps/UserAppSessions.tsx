import type { SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { SESSION_MIME } from '../reorder.js'
import { INDENT, GUIDE, ROW_PAD } from '../layout.js'
import { approvalLine } from '../rows/SessionRow.jsx'
import { ToolMark } from '../marks/ToolMark.jsx'

/**
 * The sessions of a user-folder app, indented under its row: its builder and the agents its
 * `run_agent` stood up (both have no project and carry the app's id).
 *
 * This is their one place in the sidebar. Project apps use the same nested rows in their project's
 * app list; user-folder apps have no project, and the "No app" list that used to catch every
 * session with no project is gone (2026-10-05). An agent an app started runs on `safe`, so it can
 * stop at an approval card, and a session waiting on the person must have a row to be found by.
 *
 * A session with no project that no listed app claims (a coordinator the removed control app stood
 * up, a session of an app that was removed) has no row: search, the palette and the inbox still
 * reach it.
 */
export function UserAppSessions({ sessions: own }: { sessions: SessionSummary[] }) {
  const selected = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  return own.map((s) => {
    const focused = selected === s.id
    const unread = s.lastSeq > s.lastReadSeq
    return (
      <li
        key={s.id}
        data-level={2}
        className={`relative ${INDENT[2]} ${GUIDE}`}
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
          className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} pr-3 text-left text-md transition-colors ${
            focused ? 'border-l-ink-muted bg-surface-hover/40 text-ink' : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
          }`}
        >
          <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !s.unreachable} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} />
          <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
        </button>
        {approvalLine(s, null, () => focusSession(s.id))}
      </li>
    )
  })
}
