import { agentDepthOf, type SessionInfo, type UiPreferences } from '@cc/protocol'
import type { Delegation } from './child-ownership.js'

/**
 * How deep agents may start agents (#867). A session the person started is depth 0; a session another session started
 * (`askedBy`), or one working on a task another session gave it (a delegation not yet settled: ask_project, a fork,
 * agent_session), is one deeper than that session. A fork whose requester is no longer known is at least 1.
 *
 * Counted along every link, the deepest one wins: a link that does not count would be the way around the setting, and
 * `auto` used to be that way (#862: twelve sessions at once, a load average of 216).
 */
export function sessionDepth(
  sessionId: string,
  meta: ReadonlyMap<string, Pick<SessionInfo, 'askedBy' | 'forkedFrom'>>,
  delegations: Iterable<Pick<Delegation, 'callerId' | 'sessionId' | 'settled'>>,
): number {
  const live = [...delegations].filter((d) => !d.settled)
  const walk = (id: string, path: ReadonlySet<string>): number => {
    const info = meta.get(id)
    const parents = new Set<string>()
    if (info?.askedBy) parents.add(info.askedBy)
    for (const d of live) if (d.sessionId === id && d.callerId !== id) parents.add(d.callerId)
    if (!parents.size) return info?.forkedFrom ? 1 : 0
    let deepest = 0
    // A loop (two sessions asking each other) counts once; it cannot make a chain endless
    for (const p of parents) if (!path.has(p)) deepest = Math.max(deepest, walk(p, new Set(path).add(p)))
    return deepest + 1
  }
  return walk(sessionId, new Set([sessionId]))
}

/** Where the person changes the setting, as every refusal names it */
export const AGENT_DEPTH_SETTING = '"How deep agents may start agents" in Settings → Orchestrator'

/**
 * The refusal for a caller at or past the depth (#867): what it is, the setting and where it is, and what to do instead.
 * `what` is the act refused ("start agents", "ask a project").
 */
export function agentDepthError(depth: number, limit: number, what: string): string {
  const below = `${depth} level${depth === 1 ? '' : 's'} below`
  return (
    `This session is ${below} a session the person started, and ${AGENT_DEPTH_SETTING} is ${limit}, so it cannot ` +
    `${what}. Say in your answer what is needed instead; the person can raise that setting.`
  )
}

/**
 * The refusal for a caller too deep to start agents (#867), or null when it may. The setting is read at each call, so
 * lowering it applies to the next start; no preset opens it.
 */
export function agentDepthRefusal(
  host: {
    meta: ReadonlyMap<string, Pick<SessionInfo, 'askedBy' | 'forkedFrom'>>
    children: { delegations: ReadonlyMap<string, Pick<Delegation, 'callerId' | 'sessionId' | 'settled'>> }
    uiPreferences: () => Pick<UiPreferences, 'agentDepth'>
  },
  callerId: string,
  what: string,
): string | null {
  const limit = agentDepthOf(host.uiPreferences())
  const depth = sessionDepth(callerId, host.meta, host.children.delegations.values())
  return depth < limit ? null : agentDepthError(depth, limit, what)
}
