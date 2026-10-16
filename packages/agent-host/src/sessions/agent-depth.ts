import { agentDepthOf, type SessionInfo, type UiPreferences } from '@cc/protocol'
import type { Delegation } from './child-ownership.js'

/**
 * How deep agents may start agents (#867). A session the person started is depth 0; a session another session started
 * (`askedBy`), or one working on a task another session gave it (a delegation not yet settled: ask_project, a fork,
 * agent_session), is one deeper than that session. A fork whose requester is no longer known is at least 1.
 *
 * Counted along every link, the deepest one wins: a link that does not count would be the way around the setting, and
 * `auto` used to be that way (#862: twelve sessions at once, a load average of 216).
 *
 * **Never less than the depth it was started at** (`recorded`, #897 review): a link ends when the session it points to
 * is deleted, and counted from the links alone, deleting the middle of a chain would let a grandchild start agents at a
 * setting of 2. A session another session starts records its depth when it is made (`recordAgentDepth`).
 */
export function sessionDepth(
  sessionId: string,
  meta: ReadonlyMap<string, Pick<SessionInfo, 'askedBy' | 'forkedFrom'>>,
  delegations: Iterable<Pick<Delegation, 'callerId' | 'sessionId' | 'settled'>>,
  recorded: (sessionId: string) => number = () => 0,
): number {
  const live = [...delegations].filter((d) => !d.settled)
  const walk = (id: string, path: ReadonlySet<string>): number => {
    const info = meta.get(id)
    const parents = new Set<string>()
    if (info?.askedBy) parents.add(info.askedBy)
    for (const d of live) if (d.sessionId === id && d.callerId !== id) parents.add(d.callerId)
    let deepest = -1
    // A loop (two sessions asking each other) counts once; it cannot make a chain endless
    for (const p of parents) if (!path.has(p)) deepest = Math.max(deepest, walk(p, new Set(path).add(p)))
    const linked = parents.size ? Math.max(deepest, 0) + 1 : info?.forkedFrom ? 1 : 0
    return Math.max(linked, recorded(id))
  }
  return walk(sessionId, new Set([sessionId]))
}

/**
 * Where a session's depth at its start is kept (#897 review): an app setting per session, the way `report_paused:<id>`
 * is, so an older build that does not know it leaves it alone and nothing needs a migration. The trash's purge deletes
 * it with the session (`TrashStore.purgeSession`).
 */
export const agentDepthKey = (sessionId: string) => `agent_depth:${sessionId}`

type DepthStore = { appSetting(key: string): string | null; setAppSetting(key: string, value: string): void }

/**
 * Where a hub's ask_project task marks the session of this machine working on it (#838 item 12): the depth the hub
 * counts it at, kept until that turn ends (`SessionManager.sendFromHub`). The hub's caller is on another machine, so no
 * link here leads to it; without the mark, a session asked from a linked machine could start agents and ask projects
 * as if the person had started it, past the depth on both machines. An app setting, as `agentDepthKey`: an older
 * build leaves it alone.
 */
export const hubAskDepthKey = (sessionId: string) => `hub_ask_depth:${sessionId}`

/**
 * The depth a session was started at, or 0 when none was recorded (one the person started, or made before #867); at
 * least the depth a hub's task gives it while that task's turn runs (#838)
 */
export function recordedAgentDepth(store: Pick<DepthStore, 'appSetting'>, sessionId: string): number {
  const at = (key: string) => {
    const n = Number(store.appSetting(key))
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }
  return Math.max(at(agentDepthKey(sessionId)), at(hubAskDepthKey(sessionId)))
}

/** Records a session another one started, one deeper than that session is now (#897 review) */
export function recordAgentDepth(
  host: Parameters<typeof agentDepthRefusal>[0],
  childId: string,
  starterId: string,
): void {
  host.store.setAppSetting(agentDepthKey(childId), String(depthOf(host, starterId) + 1))
}

/** A session's depth now: what a hub sends with an ask_project task to another machine, one deeper (#838) */
export function depthOf(host: Parameters<typeof agentDepthRefusal>[0], sessionId: string): number {
  return sessionDepth(sessionId, host.meta, host.children.delegations.values(), (id) => recordedAgentDepth(host.store, id))
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
    store: DepthStore
  },
  callerId: string,
  what: string,
): string | null {
  const limit = agentDepthOf(host.uiPreferences())
  const depth = depthOf(host, callerId)
  return depth < limit ? null : agentDepthError(depth, limit, what)
}
