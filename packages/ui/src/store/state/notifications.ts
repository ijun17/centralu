import type {
  NotifyPolicy,
} from '@cc/core'

/**
 * A single thing that happened off screen.
 *
 * `sessionId` is the identity — if the same session finishes again, the card is updated rather
 * than added. That way one busy session cannot crowd out the rest, and the card count never
 * exceeds the session count.
 */
export type Notice = {
  sessionId: string
  /** `agent_start`: the session asks to start another agent (#673), left as a card even while the app is in front */
  /** `question`: the agent asked the person a question (a question card) */
  kind: 'done' | 'approval' | 'error' | 'agent_start' | 'question'
  /** The session's name at that moment — kept as written even if the session is renamed later */
  name: string
  at: number
}

/** What happened off screen: notices, completion sweeps, window focus and the notify policy. */
export type NotificationsSlice = {
  appFocused: boolean
  /**
   * The session that just finished responding — the trigger for one sweep of the screen.
   * `at` is kept alongside it because the sweep must fire **every time**, even when the same session
   * finishes twice in a row (it is used as a key).
   */
  completion: { sessionId: string; at: number } | null
  /**
   * Things that happened off screen — notification cards that pile up in the top right.
   *
   * **They do not disappear on their own.** An OS banner is dismissed after a few seconds, so
   * anything that arrived while the person was away is already gone by the time they get back. That
   * is the part a banner cannot cover for this app, so this stays. There are exactly three ways it is
   * dismissed: seeing that session, clicking the card to go there, or pressing ×.
   *
   * Only one is kept per session. If one busy session filled the screen, the rest would get buried.
   */
  notices: Notice[]
  notifyPolicy: NotifyPolicy
  setAppFocused(focused: boolean): void
  /** Dismisses notification cards (× pressed, or that session was seen) */
  dismissNotices(sessionIds: string[]): void
  /**
   * Sets the notification switches (#1306): shown at once, saved through the host's preferences (only the switches that
   * changed, so the orchestrator's change to another one is not undone), and still written to the workspace snapshot for a
   * build that reads it there.
   */
  setNotifyPolicy(p: NotifyPolicy): void
}
