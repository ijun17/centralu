import type {
  ToolStatus,
  PermissionPreset,
  ToolName,
  SessionInfo,
} from '@cc/protocol/client'
import type {
  SessionSummary,
} from '@cc/core'

/** Sessions: focus, the new-session window, waking, and lifecycle actions. */
export type SessionsSlice = {
  sessions: Record<string, SessionSummary>
  /** The host's agent tools, sent over the wire so a new adapter needs no protocol change. */
  tools: ToolStatus[]
  focusedSessionId: string | null
  /**
   * The project whose new-session window is open. In the store because the first-run screen opens it and then
   * disappears as soon as a project exists.
   */
  newSessionFor: string | null
  /**
   * The manager's worktree suggestions (#69, `propose_worktree_session`), keyed to the project. A queue, so two in a row
   * both survive: each opening of that project's new-session window takes the oldest.
   */
  worktreeProposals: { projectId: string; branch: string }[]
  /** The new-session window's worktree checkbox starts on (#69): set by the `+` on a manager's row. */
  newSessionWorktree: boolean
  /** The new-session window's branch name from a suggestion (#69); empty: none */
  newSessionBranch: string
  /**
   * Sessions being woken. A session wakes when used (#568): its composer takes the keyboard or a message is sent;
   * selecting it alone does not. Waking on send only would add process startup to the first reply's wait.
   */
  resuming: Record<string, boolean>
  /** Why waking failed, shown where the screen would otherwise promise that sending resumes it. */
  wakeError: Record<string, string>
  /**
   * Waking failed because another side holds the conversation: the host's own signal, never matched from the reason's
   * wording. Only then is "split off and continue" offered.
   */
  wakeLocked: Record<string, boolean>
  /**
   * `preferGrid`: an alert's door (inbox, "done" cards) goes to the session's grid panel if it has one; the sidebar and
   * palette mean "that one, large". `reveal: false` keeps a folded project folded (#205); see `focusSession`.
   */
  focusSession(id: string | null, opts?: { preferGrid?: boolean; reveal?: boolean; targetSeq?: number }): void
  /** A waiting session, or a pending assistant proposal (an `isProposalId` id) whose card is on the Assistant (#703). */
  openWaiting(id: string, opts?: { preferGrid?: boolean }): void
  /** The newest wait first (core's `nextWaitingSession`) */
  openNextWaiting(): void
  openSearchHit(sessionId: string, seq: number): void
  /** The search result each conversation holds in sight. */
  searchTargets: Record<string, { seq: number; at: number }>
  clearSearchTarget(sessionId: string, at: number): void
  /** `null` closes the window */
  openNewSession(projectId: string | null, opts?: { worktree?: boolean }): void
  /**
   * Starts a session with the project's remembered tool, model and effort and focuses its composer (#543). A logged-out
   * tool gives way to one that is not; when none can run or the host refuses, the options window opens and says why.
   */
  startSessionNow(projectId: string): Promise<void>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      /** Overrides the project default; a handoff carries the old session's settings this way */
      effort?: string
      verbosity?: string
      serviceTier?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** Enters the record as a marker, not as the first message (#102) */
      handoff?: { from: string; note: string; fromSessionId?: string }
      /** A session the tool already has, a terminal's included */
      resumeExternalId?: string
      importHistory?: boolean
      worktree?: boolean
      /** Empty: the host picks a name (#69) */
      worktreeBranch?: string
      /** Empty: the project's trunk, else the current HEAD */
      worktreeBase?: string
    },
  ): Promise<SessionInfo>
  /** Restarts only the agent; the conversation stays */
  restartSession(sessionId: string): Promise<boolean>
  /** Moves it to the session archive (#204); the flags say what goes with it when it is deleted for good */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /**
   * The dialog's Archive before the person has seen the host's losses (#1589, #1595). Null: done (Undo or the failure on
   * the toast). Lines: not moved, what it would lose; the dialog shows them, and its next Archive is `deleteSession`.
   * No lines: not moved (not at rest, or an older host); the dialog calls `deleteSession`. With the worktree deleted
   * too, only the losses are read.
   */
  archiveSession(sessionId: string, deleteWorktree: boolean, deleteExternal: boolean): Promise<string[] | null>
  /** (#204) A project the restore registered again is added and asked about trust. Returns an error, or null when back. */
  restoreFromTrash(sessionId: string): Promise<string | null>
  /**
   * Hands off to a fresh session (the way out of a 7-13 s resume of an old codex thread). With `deleteOld` the old one
   * is deleted down to the tool's original, only once the new one is up. Another `tool` gets no model, effort,
   * verbosity or speed: they are tool-specific. `mode: 'record'` (#78, #694): the host builds the note from the store's
   * transcript; 'agent': the old session writes it.
   */
  handoffSession(
    sessionId: string,
    opts: { tool: ToolName; deleteOld: boolean; mode: 'agent' | 'record' },
  ): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: {
      model?: string | null
      effort?: string | null
      verbosity?: string | null
      serviceTier?: string | null
      permissionPreset?: PermissionPreset
    },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  /**
   * The conversation does not carry over; the caller tells the person first. A refusal is toasted here and returns
   * `false`.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<boolean>
  wake(sessionId: string): Promise<void>
  /** Branches off a locked conversation and continues it; the original is left as is. */
  forkConversation(sessionId: string): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
  /**
   * Done (#669, #1549): reads a finished or stopped turn and clears an error, moving it to idle. The error line stays
   * and nothing is retried or continued.
   */
  markDone: (sessionId: string) => Promise<void>
  /** Don't continue (#1415): the stopped turn Centralu would continue by itself waits for the person instead */
  stopContinue: (sessionId: string) => Promise<void>
  /**
   * An app's agent session is on screen (#378): the host keeps it instead of deleting it when its run ends. Said even
   * with nothing unread, which `markRead` skips.
   */
  markOpened(sessionId: string): Promise<void>
}
