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
