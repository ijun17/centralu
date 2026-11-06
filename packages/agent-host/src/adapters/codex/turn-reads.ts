/** The turn reported as still running, if any (`thread.turns[].status === 'inProgress'`) — a resume's, or a turns page's */
export function runningTurnOf(res: Record<string, unknown> | undefined): string | null {
  const turns = (res?.thread as { turns?: unknown } | undefined)?.turns
  if (!Array.isArray(turns)) return null
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as { id?: unknown; status?: unknown }
    if (t?.status === 'inProgress' && typeof t.id === 'string') return t.id
  }
  return null
}

/** `{turn: {id}}` — the turn/started notification and the turn/start response give it in the same shape */
export function turnIdOf(payload: unknown): string | null {
  const turn = (payload as { turn?: { id?: unknown } } | undefined)?.turn
  return typeof turn?.id === 'string' ? turn.id : null
}

export function threadIdOf(res: Record<string, unknown> | undefined): string | null {
  if (!res) return null
  const thread = res.thread as Record<string, unknown> | undefined
  const id = (thread?.id ?? res.threadId) as string | undefined
  return typeof id === 'string' ? id : null
}

/**
 * Whether the app-server says no turn runs in the thread (`thread.status.type`, a resume's answer). Measured (codex-cli 0.160.0, a
 * resume on the same process): `active` while a turn runs (a command in flight), `idle` after a turn completed or was interrupted, and
 * `systemError` after one failed (a capacity error). Any status that is not `active` means none runs. A resume that says no status
 * (an older Codex) says nothing: the turn goes on.
 */
export function threadRunsNoTurn(res: Record<string, unknown> | undefined): boolean {
  const thread = res?.thread
  if (typeof thread !== 'object' || thread === null || !('status' in thread)) return false
  const status = thread.status
  return typeof status === 'object' && status !== null && 'type' in status && typeof status.type === 'string' && status.type !== 'active'
}
