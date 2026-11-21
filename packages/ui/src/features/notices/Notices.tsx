import { useEffect, useState } from 'react'
import { gridSessionIds } from '@cc/core'
import { projectScreenSessions, useStore } from '../../store/store.js'
import { isOnScreen } from '../../app/onscreen.js'
import { PEEK_MS } from '../inbox/InboxPill.jsx'

/**
 * Clears notices (`notices` in the store), in this one place, by the rule for each kind; none goes on its own. The
 * inbox capsule shows them (InboxPill), not cards over the page (docs/design-system.md §6).
 */
export function Notices() {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotices)
  const view = useStore((s) => s.view)
  const appFocused = useStore((s) => s.appFocused)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const assistantId = useStore((s) => s.assistantId)
  // Joined into one string, as projectScreen below: a selector that returns a new array on every call never settles
  const gridSessions = useStore((s) => gridSessionIds(s.gridPanels).join(' '))
  const builderPaneSessionId = useStore((s) => s.builderPaneSessionId)
  const projectScreen = useStore((s) => projectScreenSessions(s).join(' '))

  /*
   * The rule reads the state as it is, so no path that saw or answered a notice leaves it behind. A finished turn is
   * seen once its capsule line folded (PEEK_MS) with the app in front and the session on screen; one made while away is
   * decided on return. The others stand until answered, or until the session leaves the error.
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
        assistantId,
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
            case 'done':
              return now - n.at >= PEEK_MS && onScreen(n.sessionId)
            case 'approval':
            case 'agent_start':
              return s.state !== 'waiting_approval'
            case 'question':
              return s.pendingQuestions.length === 0
            case 'error':
              return s.state !== 'error'
          }
        })
        .map((n) => n.sessionId),
    )
  }, [notices, sessions, tick, appFocused, view, focusedSessionId, assistantId, gridSessions, builderPaneSessionId, projectScreen, dismiss])

  return null
}
