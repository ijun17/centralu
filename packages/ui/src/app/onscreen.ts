/**
 * What is visible on screen right now — the basis for whether the completion gust blows.
 *
 * This filename must not differ from Gust.tsx by case alone. The macOS filesystem is
 * case-insensitive, so the bundler picks up the wrong file — the type check still passes, but the
 * screen comes up completely blank.
 *
 * It only blows when the finished session is currently on screen. Sweeping across sessions that
 * are not visible would mean an unrelated gust keeps passing by while reading something else — and
 * it gets worse the more sessions there are. Something that finished off screen is already spoken
 * for by the badge and the notification.
 *
 * This animation's whole job is to tell the body, and only the body, the single fact that "what
 * is being looked at right now has finished".
 */
export type View = 'focus' | 'grid' | 'assistant' | 'app'

export type Onscreen = {
  focusedSessionId: string | null
  assistantId: string | null
  /** The sessions on the grid (#288: the grid also holds apps, which never finish a turn) */
  gridSessions: readonly string[]
  /** The builder session whose conversation is open beside the visible pinned screen (M4 B-2)
   * (BuilderPane) — null if there is none */
  builderPaneSessionId?: string | null
  /** The sessions the project screen shows (#203), empty when it is not showing (`projectScreenSessions`) */
  projectScreen?: readonly string[]
}

export function isOnScreen(view: View, sessionId: string, ctx: Onscreen): boolean {
  /*
   * The focus lane with no session picked is the project screen (#203), and it shows the sessions explicitly added
   * as panels. Answering "not on screen" for them would put a "Finished" card (and a sound) over the very panel the
   * person is watching finish.
   */
  if (view === 'focus') return ctx.focusedSessionId ? ctx.focusedSessionId === sessionId : !!ctx.projectScreen?.includes(sessionId)
  if (view === 'assistant') return ctx.assistantId === sessionId
  /*
   * The pinned screen (M4 B-2) occupies the main area — the only visible conversation is the one
   * builder session opened beside it (BuilderPane). Counted as "not visible", it would pop a
   * "Finished" card (and sound) every time its turn ends, right while the person fixing the app is
   * watching it beside them, and the card would sit on top of the pinned screen's header (Builder,
   * Runs, close) and the Runs tab's Refresh, intercepting clicks (the card stays until it is
   * dismissed).
   */
  if (view === 'app') return !!ctx.builderPaneSessionId && ctx.builderPaneSessionId === sessionId
  // The grid shows several at once — even one of them finishing counts as finishing on screen
  return ctx.gridSessions.includes(sessionId)
}
