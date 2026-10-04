/**
 * What a host writes on each child it asks the keeper to spawn, so the next host knows what it is
 * looking at (#280 step 2). The keeper stores the tag and hands it back untouched; only hosts read
 * it, so its shape is the host's alone to change — and a newer host must keep reading an older
 * host's tags, because the children outlive the build that spawned them.
 */

export type AgentTag = { kind: 'agent'; tool: string; sessionId: string }
export type TerminalTag = { kind: 'terminal'; id: string; cwd: string }
export type CommandTag = { kind: 'command'; cwd: string; command: string; runId: string; startedAt: number }
export type ChildTag = AgentTag | TerminalTag | CommandTag

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A tag this build understands, or null — a child spawned by something else is left alone. */
export function parseTag(raw: unknown): ChildTag | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  if (t.kind === 'agent' && str(t.tool) && str(t.sessionId)) return { kind: 'agent', tool: t.tool, sessionId: t.sessionId }
  if (t.kind === 'terminal' && str(t.id) && str(t.cwd)) return { kind: 'terminal', id: t.id, cwd: t.cwd }
  if (t.kind === 'command' && str(t.cwd) && str(t.command) && str(t.runId)) {
    return { kind: 'command', cwd: t.cwd, command: t.command, runId: t.runId, startedAt: Number(t.startedAt) || Date.now() }
  }
  return null
}

/** The number in an id like `term-12` or `run-3`, so a new id never collides with a kept one. */
export function idNumber(id: string): number {
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}
