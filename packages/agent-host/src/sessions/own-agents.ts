import type { SessionInfo } from '@cc/protocol'
import type { AgentListRow } from '../adapters/contract.js'
import { inTurn } from '../idle.js'
import type { DelegationHost } from './delegation-host.js'

/**
 * A session's own agents and where each stands (#690), one rule for the two places that say it: agent_session list
 * (`DelegationFlow.listAgents`) and a finished child's report, which counts the other finished ones
 * (`ChildReports.cleanUpWords`). Counted apart, the report said "2 other finished" of children list showed working.
 */
export type OwnAgentsHost = Pick<DelegationHost, 'children' | 'meta' | 'trashing'>

/**
 * The sessions `callerId` started that are still here, oldest first: `askedBy` in its own project, not on the way to
 * the session archive. `askedBy` only, as status, send, wait and stop take them: `parentSessionId` alone is the former worktree
 * manager's link, which store step v48 copied into `askedBy`, and delete accepts it only for a child without a worktree
 * (#637). A row that has only that link is the person's to clean up.
 */
export function ownAgents(host: OwnAgentsHost, callerId: string): SessionInfo[] {
  const caller = host.meta.get(callerId)
  // The orchestrator's children have no project (#853): its own place is none
  const projectId = caller?.kind === 'orchestrator' ? null : caller?.projectId
  if (projectId === undefined || (projectId === null && caller?.kind !== 'orchestrator')) return []
  return [...host.meta.values()]
    .filter((s) => s.id !== callerId && s.askedBy === callerId && s.projectId === projectId && !host.trashing.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Where one of them stands: a card on it, a turn or a delegation running, stopped short, or finished */
export function agentState(host: OwnAgentsHost, s: SessionInfo): AgentListRow['state'] {
  const running = [...host.children.delegations.values()].some((d) => d.sessionId === s.id && !d.settled)
  return s.pendingApproval || s.pendingQuestions.length ? 'waiting'
    : inTurn(s.state) || running ? 'working'
    : s.state === 'error' || s.state === 'limited' || s.interruption ? 'stopped'
    : 'finished'
}

/**
 * Whether an answer about `child` may tell `callerId` to delete it (#690 review): only its own child (under `auto`,
 * agent_session also reads the person's sessions and siblings), and only one whose work is over. A turn the network,
 * a quit or a limit cut short is resumed, not deleted; a report still owed over its own background work (`notice`)
 * is not over.
 */
export function cleanUpDue(child: SessionInfo, callerId: string, notice?: string): boolean {
  return child.askedBy === callerId && !notice && !child.interruption && child.state !== 'error' && child.state !== 'limited'
}
