import { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type MailParty, type NotifyPolicy, type SessionState } from '@cc/protocol/client'
import { partyName } from '../inbox/mail-party.js'

/**
 * Notification policy (FR-12 display layer ④).
 * Principle: **a notification is the only means that forcibly takes the person's attention**, so it is the
 * one used most sparingly. Only approvals and errors notify at once; awaiting response is a badge only.
 * (The "all done" notification was retired on 2026-10-20, #1429.)
 */

/** The policy moved to the protocol with the preferences (#1306): the host keeps it, the screen and the Assistant share it */
export { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type NotifyPolicy }

export type NotifyRequest = { kind: 'approval' | 'error' | 'all_done' | 'mail'; sessionId?: string; title: string; body: string }

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
  const policy = policyNow(ctx)
  if (!policy || session.state === prevState) return null

  if (session.state === 'waiting_approval' && policy.approval) {
    return { kind: 'approval', sessionId: session.id, title: 'Awaiting approval', body: `${session.name} — agent is blocked, waiting` }
  }
  if (session.state === 'error' && policy.error) {
    return { kind: 'error', sessionId: session.id, title: 'Error', body: `${session.name} — session stopped` }
  }
  return null
}

/**
 * A new message the person can read → a notification (#1630, owner decision): every one, of any kind, under the switches every
 * notification follows (`policyNow`) and none of an approval's, a question included: it holds no tool call. The host names
 * only a message the person did not write (`mail_changed.arrived`), once
 */
export function mailNotification(arrived: { from: MailParty; kind: string; preview: string }, ctx: NotifyContext): NotifyRequest | null {
  if (!policyNow(ctx)) return null
  return { kind: 'mail', title: `${arrived.kind === 'question' ? 'Question' : 'Mail'} from ${partyName(arrived.from)}`, body: arrived.preview }
}

/** The one read of the person's switches every notification starts from: the policy, or null while the app is in view and they asked for none there */
function policyNow(ctx: NotifyContext): NotifyPolicy | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  return ctx.appFocused && !policy.whenFocused ? null : policy
}

/**
 * The dock badge number — counts only approvals and errors (awaiting response is not urgent, so it does not
 * go on the badge)
 */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
