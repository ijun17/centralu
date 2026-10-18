import { useEffect, useState } from 'react'
import { gridSessionIds } from '@cc/core'
import { projectScreenSessions, useStore } from '../../store/store.js'
import { isOnScreen } from '../../app/onscreen.js'
import { PEEK_MS } from '../inbox/InboxPill.jsx'

/**
 * Things that happened in a session are kept as notices (`notices` in the store) until they are done with (below).
 *
 * They are shown by the inbox's capsule in the top bar (InboxPill): a new one is written out there for a few seconds.
 * The cards that used to stack in the top right were removed (owner, 2026-10-18) because they covered the page.
 * A notice never disappears on its own: it is cleared here, in one place, by the rule for its kind.
 */
export function Notices() {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotices)
  const view = useStore((s) => s.view)
  const appFocused = useStore((s) => s.appFocused)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const orchestratorId = useStore((s) => s.orchestratorId)
  // Joined for the same reason as below — the grid's sessions, derived from its panels (#288)
  const gridSessions = useStore((s) => gridSessionIds(s.gridPanels).join(' '))
  const builderPaneSessionId = useStore((s) => s.builderPaneSessionId)
  // Joined into one string: a selector that returns a new array on every call never settles
  const projectScreen = useStore((s) => projectScreenSessions(s).join(' '))

  /*
   * When a notice is done with, by kind (owner, 2026-10-18). The check lives in **one place, here**: whatever path
   * led to it being seen or answered, the rule reads the state as it is, so no path can leave one behind.
   *  - A finished turn: seen once its line in the capsule has folded (PEEK_MS after it arrived) while the app is in
   *    front and the session on screen. Made while away, it is decided when the person comes back.
   *  - An approval, a request to start an agent: when it is answered (the session no longer waits on one).
   *  - A question the agent asked: when no question card is left.
   *  - An error: when the session leaves it.
   */
  const sessions = useStore((s) => s.sessions)
  // Re-read when a finished turn's line folds: that is when "seen" is decided for it
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const now = Date.now()
    const due = notices.filter((n) => n.kind === 'done' && now - n.at < PEEK_MS).map((n) => n.at + PEEK_MS - now)
    if (due.length === 0) return
    const t = setTimeout(() => setTick((x) => x + 1), Math.min(...due) + 20)
    return () => clearTimeout(t)
  }, [notices, tick])
  useEffect(() => {
    const now = Date.now()
    const onScreen = (id: string) =>
      appFocused &&
      isOnScreen(view, id, {
        focusedSessionId,
        orchestratorId,
        gridSessions: gridSessions ? gridSessions.split(' ') : [],
        builderPaneSessionId,
        projectScreen: projectScreen ? projectScreen.split(' ') : [],
      })
    dismiss(
      notices
        .filter((n) => {
          const s = sessions[n.sessionId]
          if (!s) return true
          switch (n.kind) {
            // Seen if, when its line has folded, the app is in front and the session on screen
            case 'done':
              return now - n.at >= PEEK_MS && onScreen(n.sessionId)
            // Stands until it is answered: the session no longer waits on an approval
            case 'approval':
            case 'agent_start':
              return s.state !== 'waiting_approval'
            // Stands until every question the agent asked is answered
            case 'question':
              return s.pendingQuestions.length === 0
            // Stands until the session leaves the error
            case 'error':
              return s.state !== 'error'
          }
        })
        .map((n) => n.sessionId),
    )
  }, [notices, sessions, tick, appFocused, view, focusedSessionId, orchestratorId, gridSessions, builderPaneSessionId, projectScreen, dismiss])

  /*
   * The cards that stood here in the top right are gone (owner, 2026-10-18): they covered the conversation, and the
   * inbox's capsule in the top bar says the same thing now (features/inbox/InboxPill.tsx writes a new notice out for a
   * few seconds). What stays is this component's other job, clearing a notice once its session is on screen.
   */
  return null
}
