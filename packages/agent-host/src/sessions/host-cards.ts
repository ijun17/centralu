import type { ApprovalDetail, SessionState } from '@cc/protocol'

/** A card the host raised in a session's approval slot (M4 D-4, #371) — see `SessionManager.hostAsks` */
export type HostAsk = {
  requestId: string
  sessionId: string
  detail: Extract<ApprovalDetail, { kind: 'capability' | 'project_access' | 'project_create' | 'agent_start' | 'centralu_update' | 'other' }>
  shown: boolean
  /** The state the session rested in when the card was raised between turns (#673), to return to once it closes */
  restState?: SessionState
  resolve: (d: HostAskAnswer) => void
}

/**
 * The answer to a card the host raised: the three of an approval, or null when it was withdrawn unanswered.
 * 'always_project' is agent_start's always with the project scope (#561); every other card has one always.
 */
export type HostAskAnswer = 'allow' | 'always' | 'always_project' | 'deny' | null
