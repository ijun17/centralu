import type { ApprovalDetail } from '@cc/protocol'

/**
 * A start_agent request waiting on the person's card (#673), as stored in `agent_start_requests`: everything the start
 * needs once allowed, so a host that takes over after a swap or restart can raise the card again and start the child.
 */
export type AgentStartRequest = {
  requestId: string
  callerId: string
  projectId: string
  tool: string
  model?: string
  effort?: string
  worktreeBranch?: string
  task: string
  unchecked?: string
  /** start_agent's code intelligence choice (#686) */
  lsp?: boolean
  /** The name the child starts with (#861): the caller's, or one made from its task; absent for a worktree child named by its branch */
  name?: string
  /**
   * The start is allowed (by the card or the project's trust) and waits only for memory (#686): a host that takes it
   * over starts it when memory allows, without raising the card again
   */
  allowed?: true
  detail: Extract<ApprovalDetail, { kind: 'agent_start' }>
}

/** One such request while this host serves it (`ChildOwnership.agentStarts`) */
export type AgentStartRecord = {
  req: AgentStartRequest
  /** The call that raised it has answered "pending" (#673): how it ends is told to the caller as a message */
  detached: boolean
  ended?: { childId: string } | { error: string }
  /** Resolves when it ends (agent_session wait on the handle) */
  done: Promise<void>
  end: () => void
  /** Allowed, and queued until memory recovers (#686): what was read when it was queued */
  lowMemory?: LowMemory
  /** Ends the wait for memory, when the request ends another way (withdrawn, the caller deleted) */
  stopWaiting?: () => void
  /** The caller's waits on the handle now, ended when a handoff gives the request to another session (#693) */
  leaving?: Set<() => void>
}

/** A start queued for memory (#686), as the caller reads it */
export type LowMemory = { available: string; floor: string; maxWaitMinutes: number }
