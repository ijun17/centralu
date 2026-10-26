import { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type NotifyPolicy, type SessionState } from '@cc/protocol'

/**
 * Notification policy (FR-12 display layer ④).
 * Principle: **a notification is the only means that forcibly takes the person's attention**, so it is the
 * one used most sparingly. Only approvals and errors notify at once; awaiting response is a badge only.
 * (The "all done" notification was retired on 2026-10-20, #1429.)
 */

/** The policy moved to the protocol with the preferences (#1306): the host keeps it, the screen and the orchestrator share it */
export { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type NotifyPolicy }

export type NotifyRequest = { kind: 'approval' | 'error' | 'all_done'; sessionId?: string; title: string; body: string }

export type NotifyContext = {
  appFocused: boolean
  policy?: NotifyPolicy
}

/** Session state transition → notification (null when there is none) */
export function notificationFor(
  session: { id: string; name: string; state: SessionState },
  prevState: SessionState,
  ctx: NotifyContext,
): NotifyRequest | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  if (ctx.appFocused && !policy.whenFocused) return null
  if (session.state === prevState) return null

  if (session.state === 'waiting_approval' && policy.approval) {
    return { kind: 'approval', sessionId: session.id, title: 'Awaiting approval', body: `${session.name} — agent is blocked, waiting` }
  }
  if (session.state === 'error' && policy.error) {
    return { kind: 'error', sessionId: session.id, title: 'Error', body: `${session.name} — session stopped` }
  }
  return null
}

/**
 * The dock badge number — counts only approvals and errors (awaiting response is not urgent, so it does not
 * go on the badge)
 */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
