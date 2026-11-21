import type {
  NotifyPolicy,
} from '@cc/core'

/** Something that happened off screen; one per session, updated in place, so a busy session cannot crowd out the rest. */
export type Notice = {
  sessionId: string
  /** `agent_start`: the session asks to start another agent (#673), a card even while the app is in front */
  kind: 'done' | 'approval' | 'error' | 'agent_start' | 'question'
  /** The session's name then, kept through a later rename */
  name: string
  at: number
}

/** What happened off screen: notices, completion sweeps, window focus and the notify policy. */
export type NotificationsSlice = {
  appFocused: boolean
  /** The session that just finished, the trigger for one sweep; `at` keys it, so the same session twice sweeps twice. */
  completion: { sessionId: string; at: number } | null
  /**
   * Cards in the top right that never time out, unlike an OS banner, so they wait for a person who was away. They go
   * when the session is seen, the card is clicked, or × is pressed.
   */
  notices: Notice[]
  setAppFocused(focused: boolean): void
  dismissNotices(sessionIds: string[]): void
  /**
   * `prefs.notifyPolicy` (#1306, #2168): shown at once, saved through the host's preferences with only the switches that
   * changed, so the Assistant's change to another one is not undone.
   */
  setNotifyPolicy(p: NotifyPolicy): void
}
