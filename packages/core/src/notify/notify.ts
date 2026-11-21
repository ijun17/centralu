import { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type MailParty, type NotifyPolicy, type SessionState } from '@cc/protocol/client'
import { partyName } from '../inbox/mail-party.js'

/**
 * Notification policy (FR-12): the only means that forces attention, so used most sparingly. Only an approval and mail
 * notify; awaiting response is a badge only. The "all done" and "error" switches are stored and followed by nothing (#2168).
 */

/** In the protocol (#1306): the host keeps it, the screen and the Assistant share it */
export { DEFAULT_NOTIFY_POLICY, readNotifyPolicy, type NotifyPolicy }

export type NotifyRequest = { kind: 'approval' | 'mail'; sessionId?: string; title: string; body: string }

export type NotifyContext = {
  appFocused: boolean
  policy?: NotifyPolicy
}

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
  return null
}

/**
 * Every message of any kind (#1630), under the common switches and none of an approval's: a question holds no tool call.
 * The host names only a message the person did not write, once.
 */
export function mailNotification(arrived: { from: MailParty; kind: string; preview: string }, ctx: NotifyContext): NotifyRequest | null {
  if (!policyNow(ctx)) return null
  return { kind: 'mail', title: `${arrived.kind === 'question' ? 'Question' : 'Mail'} from ${partyName(arrived.from)}`, body: arrived.preview }
}

/** Null while the app is in view and the person asked for none there */
function policyNow(ctx: NotifyContext): NotifyPolicy | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  return ctx.appFocused && !policy.whenFocused ? null : policy
}

/** Awaiting response is not urgent, so it is not on the badge */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
