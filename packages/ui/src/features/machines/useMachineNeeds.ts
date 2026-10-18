import { useEffect } from 'react'
import { machinesInUse } from '@cc/core'
import { useStore } from '../../store/store.js'
import type { AppState } from '../../store/state.js'

/**
 * How often the window says again that it needs a machine while one of its projects or sessions stays open (#1134). The
 * host keeps such a machine connected for 10 minutes after the last time it heard so (`NEED_HOLD_MS` in
 * links/linked-machine-connection.ts); five times within that, so a window that is busy or asleep for a moment does not
 * drop the link under the person
 */
export const NEED_REPEAT_MS = 2 * 60_000

/** The machines the window has open, as one string, so the effect below runs again only when the set changes */
export function neededKey(s: Pick<AppState, 'focusedSessionId' | 'focusedProjectId' | 'viewerProjectId' | 'sessions' | 'projects' | 'machines'>): string {
  const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : null
  const projects = [s.focusedProjectId, s.viewerProjectId, session?.projectId].map((id) => (id ? s.projects[id] : null))
  return machinesInUse({ session, projects }, s.machines).join(' ')
}

/**
 * Tells the host which machines that connect when needed this window needs (#1134): the one a focused session runs
 * on, and the one whose project is open. Said when that changes and again every `NEED_REPEAT_MS` while it stays so; a
 * machine connected at start is never named, so an older host is never asked
 */
export function useMachineNeeds(): void {
  const key = useStore(neededKey)
  useEffect(() => {
    if (!key) return
    const say = () => {
      for (const id of key.split(' ')) void useStore.getState().needMachine(id)
    }
    say()
    const timer = setInterval(say, NEED_REPEAT_MS)
    return () => clearInterval(timer)
  }, [key])
}
