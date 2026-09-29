import type { SessionState } from '@cc/protocol'
import { isWaiting } from '../session/state-machine.js'

/**
 * Notification policy (FR-12 display layer ④).
 * Principle: **a notification is the only means that forcibly takes the person's attention**, so it is the
 * one used most sparingly. Only approvals and errors notify at once; awaiting response is a badge only.
 * Instead, there is one notification "when everything has finished".
 */

export type NotifyPolicy = {
  /** Notify at once when an approval starts waiting */
  approval: boolean
  /** Notify at once when an error occurs */
  error: boolean
  /**
   * When a single session finishes a response **somewhere it cannot be seen**.
   *
   * Originally the sound came only "once, when everything has finished". That fell out of step once every
   * off-screen finish started leaving a card — the cards piled up every time but the sound came only at the
   * end, so if two sessions finished while the person was away, two cards had quietly piled up. A card and
   * a sound are the same event, so they go together.
   */
  done: boolean
  /** Once, when every session has finished its work */
  allDone: boolean
  /**
   * Whether to notify even while the app is in the foreground (default: no — a notification about something
   * right in front of you is noise)
   */
  whenFocused: boolean
  /**
   * Whether to make a sound.
   *
   * Since we measured that the macOS banner path is dead, **sound has been the main signal while the person
   * is away**. It is the only signal that reaches them even in the next room, so it is on by default.
   */
  sound: boolean
}

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  approval: true,
  error: true,
  done: true,
  allDone: true,
  whenFocused: false,
  sound: true,
}

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
 * Deciding "all done" (a policy decided in product-spec).
 * It notifies once, when all the work is done, not every time an individual session finishes —
 * that is the signal someone who has left the desk needs.
 */
export function allDoneNotification(
  sessions: readonly { id: string; state: SessionState }[],
  prevSessions: readonly { id: string; state: SessionState }[],
  ctx: NotifyContext,
): NotifyRequest | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  if (!policy.allDone) return null
  if (ctx.appFocused && !policy.whenFocused) return null

  /*
   * The opposite of "finished" is not only working.
   *
   * waiting_approval means the agent is blocked, not that its hands are free, and limited resumes on its
   * own once the limit lifts — if "All done" went off in these states, the person would think everything
   * was finished and leave the desk while approval cards were piling up.
   */
  const isBusy = (s: { state: SessionState }) =>
    s.state === 'working' || s.state === 'waiting_approval' || s.state === 'limited'

  const active = sessions.length

  /*
   * **Decided by identity, not by count.**
   *
   * A count comparison like busy(prev)>0 && busy(now)===0 also holds **the moment the last working session
   * is archived or deleted** — the work did not finish, it was put away, and yet "All done" goes off. It is
   * finished only when the very sessions that were busy **are still in the list, have not been put away,
   * and have actually let go of the work**.
   */
  const prevBusy = prevSessions.filter(isBusy).map((s) => s.id)
  if (prevBusy.length === 0 || active === 0) return null
  const now = new Map(sessions.map((s) => [s.id, s]))
  for (const id of prevBusy) {
    const s = now.get(id)
    if (!s || isBusy(s)) return null
  }
  // Nor is it finished if some session became busy in the meantime
  if (sessions.some(isBusy)) return null

  const waiting = sessions.filter((s) => isWaiting(s.state)).length
  return {
    kind: 'all_done',
    title: 'All done',
    body: waiting > 0 ? `${waiting} sessions are waiting for input` : 'Every session has finished',
  }
}

/**
 * The dock badge number — counts only approvals and errors (awaiting response is not urgent, so it does not
 * go on the badge)
 */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
