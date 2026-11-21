/**
 * Which sessions are visible now: the completion gust blows only for one finishing on screen (the badge and the
 * notification speak for the rest). Never name this file like Gust.tsx up to case: on macOS's case-insensitive
 * filesystem the bundler loads the wrong file, types still pass, and the screen comes up blank.
 */
export type View = 'focus' | 'grid' | 'assistant' | 'app'

export type Onscreen = {
  focusedSessionId: string | null
  assistantId: string | null
  /** Sessions only (#288: the grid's apps never finish a turn) */
  gridSessions: readonly string[]
  /** The builder session open beside the pinned screen (BuilderPane) */
  builderPaneSessionId?: string | null
  /** The sessions the project screen shows (#203), empty when it is not showing (`projectScreenSessions`) */
  projectScreen?: readonly string[]
}

export function isOnScreen(view: View, sessionId: string, ctx: Onscreen): boolean {
  // With no session picked, the focus lane is the project screen (#203): its panels are on screen
  if (view === 'focus') return ctx.focusedSessionId ? ctx.focusedSessionId === sessionId : !!ctx.projectScreen?.includes(sessionId)
  if (view === 'assistant') return ctx.assistantId === sessionId
  // Else a "Finished" card would cover the pinned screen's header and Refresh, catching clicks until dismissed
  if (view === 'app') return !!ctx.builderPaneSessionId && ctx.builderPaneSessionId === sessionId
  return ctx.gridSessions.includes(sessionId)
}
