import type {
  ToolStatus,
  PermissionPreset,
  ToolName,
  SessionInfo,
} from '@cc/protocol'
import type {
  SessionSummary,
} from '@cc/core'

/** Sessions: focus, the new-session window, waking, and lifecycle actions. */
export type SessionsSlice = {
  sessions: Record<string, SessionSummary>
  /**
   * Which agent tools this machine has, as the host reports them.
   *
   * The screens that draw a row per tool used to read a `TOOL_META` constant compiled into
   * `@cc/protocol`, which meant the set of tools was fixed at build time and a new adapter
   * could not appear without editing the protocol. It arrives over the wire now, so it has
   * to be held somewhere every screen can reach — the chips in the sidebar need the label
   * and the mark synchronously, once per row.
   */
  tools: ToolStatus[]
  focusedSessionId: string | null
  /**
   * The project whose session-creation window is open (`null` means closed).
   *
   * This used to be local state on the sidebar panel, and was lifted into the store because **the
   * first-run screen needs to open this window.** The moment a project is created, the first-run
   * screen disappears (`App` branches on whether any project exists), so the only way for that
   * screen to hand off its next step is to reserve a window that will stand somewhere else, in
   * place of the screen that is about to disappear.
   */
  newSessionFor: string | null
  /**
   * A worktree suggestion from the manager (#69). Set by `propose_worktree_session`, and consumed
   * when that project's new-session window opens — the window comes up with the worktree toggle on
   * and the branch name filled in. The reason it is keyed to the project: letting it bleed into
   * another project's window would contaminate the suggestion.
   */
  /**
   * A queue (dogfooding for #69): when the manager suggested two branches back to back, a single
   * slot meant only the last one survived — the first suggestion had to be typed by hand after
   * reading the name off the conversation. Each time the window opens, it consumes that project's
   * oldest suggestion (FIFO).
   */
  worktreeProposals: { projectId: string; branch: string }[]
  /**
   * Whether the new-session window opens with the worktree checkbox on (#69). Turned on by the `+`
   * on the manager's row, because a session created under a manager defaults to a worktree session.
   * Turning it off in the window is free (a preset, not a requirement).
   */
  newSessionWorktree: boolean
  /** The initial branch name for the new-session window (#69) — filled by a suggestion. An empty string means none */
  newSessionBranch: string
  /**
   * The session currently being woken up.
   *
   * Picking a session **wakes it immediately.** It used to wake on send, which piles the whole
   * process-startup time onto the time between turning the app on and the first response. Worse, a
   * sleeping session has no process to ask, so it cannot even hand back its slash-skill list. The
   * act of picking already means "I am about to use this session," so preparation starts right then.
   */
  resuming: Record<string, boolean>
  /**
   * **Why** waking it failed.
   *
   * This used to fail silently ("it will retry when sending anyway"). But the screen read "sending a
   * message will resume it automatically" while it actually would not resume, and the person had no
   * way to find out why (pointed out during dogfooding). No silent failures — the reason is written
   * right there.
   */
  wakeError: Record<string, string>
  /**
   * Whether waking it failed **because another side is holding it**.
   *
   * This is never decided by pattern-matching the reason text with a regex — the moment the wording
   * changes, that check breaks silently. The host sends this down as its own separate signal, and it
   * is simply carried as is. Only when this is true is "split off and continue" offered (that is the
   * only case where that path is actually open).
   */
  wakeLocked: Record<string, boolean>
  /**
   * Show a session.
   *
   * `preferGrid` is for the doors that alerts open (the inbox, the "done" cards): if the
   * session already has a panel on the grid, go there instead of replacing the grid with
   * one big pane. You put it on the grid to watch it; an alert about it is not a reason to
   * take the other panels off the screen. Deliberate navigation — the sidebar, the palette —
   * leaves this off: picking a row means "give me that one, large".
   *
   * `reveal: false` keeps a folded project folded (#205). Every other door unfolds the
   * session's project, so the row it lands on is visible; see `focusSession` for the two
   * callers that pass it.
   */
  focusSession(id: string | null, opts?: { preferGrid?: boolean; reveal?: boolean; targetSeq?: number }): void
  /**
   * Goes to one thing that waits on the person (#703): a session, or a pending orchestrator proposal (an id from
   * `isProposalId`), whose card stands on the orchestrator's screen. The waiting list and "next waiting" use it.
   */
  openWaiting(id: string, opts?: { preferGrid?: boolean }): void
  /** Opens a search result at its stored conversation row. */
  openSearchHit(sessionId: string, seq: number): void
  /** The search result the conversation is currently holding in sight, by session. */
  searchTargets: Record<string, { seq: number; at: number }>
  /** A reader moved away from a search result, so it no longer needs emphasis. */
  clearSearchTarget(sessionId: string, at: number): void
  /** Opens/closes the session-creation window (`null` closes it) */
  openNewSession(projectId: string | null, opts?: { worktree?: boolean }): void
  /**
   * Starts a session in the project at once, with what the project remembers (its last tool, and that tool's model and
   * effort: `createSession` reads them), and gives the new session's composer the keyboard (#543). A remembered tool that
   * is logged out gives way to one that is not (the dialog's rule); when none can run, or the host refuses, the options
   * window opens instead and states why: a one-click start must never end in "nothing happened".
   */
  startSessionNow(projectId: string): Promise<void>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      /** When given, this value is used instead of the project default — used to carry a dying session's settings whole through a handoff */
      effort?: string
      verbosity?: string
      serviceTier?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** An inherited handoff note — enters as a marker in the record, not as the first message (#102) */
      handoff?: { from: string; note: string; fromSessionId?: string }
      /** Resumes a previous session the tool already had (including a conversation created in a terminal) */
      resumeExternalId?: string
      importHistory?: boolean
      /** Runs only this session in a git worktree (FR-2 option) */
      worktree?: boolean
      /** The worktree branch name (#69). If empty, the host uses an automatic name */
      worktreeBranch?: string
      /** Where to branch off from. If empty, the project's trunk, or if there is none, the current HEAD */
      worktreeBase?: string
    },
  ): Promise<SessionInfo>
  /** Hides from the list / brings back (the record survives) */
  /** Restarts only the agent (the conversation stays as is) */
  restartSession(sessionId: string): Promise<boolean>
  /** Moves the session to the session archive (#204); the two flags say what goes with it when it is deleted for good */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /**
   * Brings a session back from the session archive (#204). A project its restore registered again is added here, and asked
   * about trust as a newly added one is. Returns an error message, or null when it is back.
   */
  restoreFromTrash(sessionId: string): Promise<string | null>
  /**
   * Hands off and starts fresh (a dogfooding request — the way out of the 7-13 second resume delay
   * on an old codex thread). The dying session writes a handoff note → the new session starts from
   * that note → the old session (by default) is **actually** deleted, all the way down to the tool's
   * own original. Destruction comes last: nothing is deleted until the new session is successfully
   * up.
   *
   * tool: can also hand off to a different agent (the note is plain text, so it does not care which
   * tool reads it). Defaults to the current tool. Switching tools does not carry over the model,
   * effort, verbosity or speed — those are all tool-specific values, and handing codex's model name
   * to claude would fail right at session creation.
   * deleteOld: defaults to the mode's pairing (below): deleted for 'agent', kept for 'record'. Kept, the old session stays
   * standing — a branch, not a switch.
   */
  /**
   * mode 'record' (default since #694; #78 made it for a session whose service was cut off): asks the
   * agent nothing and has the host build the note straight from the store's own transcript. 'agent':
   * the departing session writes the note. deleteOld's default follows the mode: kept for 'record'.
   */
  handoffSession(
    sessionId: string,
    opts?: { tool?: ToolName; deleteOld?: boolean; mode?: 'agent' | 'record' },
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
   * Switches a session's agent (claude ↔ codex).
   * **The conversation does not carry over** — the caller must tell the person that beforehand.
   * A refusal is toasted here; `false` says it happened, so a caller does not show the switch as done.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<boolean>
  /** Wakes a session the instant it is picked (so we do not wait for the first response) */
  wake(sessionId: string): Promise<void>
  /**
   * Branches off a locked conversation and continues it.
   * The only way out that does not require going elsewhere to close another app — the original is
   * left as is.
   */
  forkConversation(sessionId: string): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
  /**
   * The person has an app's agent session on screen (#378): the host keeps it as theirs instead of deleting it when its
   * run ends. Said at once, with nothing unread too, which `markRead` skips
   */
  markOpened(sessionId: string): Promise<void>
}
