import type {
  QuestionAnswer,
  StoredMessage,
} from '@cc/protocol/client'
import type { ChatAttachment, ChatItem } from '../transcript.js'

/** Not yet sent. Text and attachments move together, so neither is left behind */
export type Draft = { text: string; attachments: ChatAttachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** A draft whose session is gone (`ConversationSlice.keptDrafts`); `name` is the session's, when the window knew it */
export type KeptDraft = { sessionId: string; name: string | null; text: string }

/**
 * A launch card's subagent steps (#222, docs/state-management.md §4). `rows`: oldest first by `seq`; `more`: the host
 * has more, and live steps wait for them; `trashed`: steps in the session archive (#418), read with the first page.
 */
export type SubagentSteps = { open: boolean; rows: StoredMessage[]; more: boolean; loading: boolean; error: string | null; trashed?: number }

/** One conversation on screen: transcript, drafts, scroll position, history paging, sending and answering. */
export type ConversationSlice = {
  chat: Record<string, ChatItem[]>
  /**
   * Per session, not in the composer (docs/state-management.md "Composer text and selection"): the focus view reuses one
   * composer, so A's text would be sent to B. Not persisted.
   */
  drafts: Record<string, Draft>
  /**
   * Drafts of sessions that are gone (#378), oldest first, until copied or put away: the host deletes an app's agent
   * session when its run ends, maybe just after a failed send went back to the draft. Text only: attachments went with it.
   */
  keptDrafts: KeptDraft[]
  /**
   * Whether a conversation was left at its newest line (#31), in the store because the grid remounts panels. Not a pixel
   * offset: a virtualizer that has not measured its rows lands only near it. Absent means yes. Not persisted.
   */
  stickToBottom: Record<string, boolean>
  /**
   * Where a conversation left above the bottom was (#61): the `seq` of the row at the top and the offset in it, which
   * survive remeasuring, unlike a pixel offset. Absent at the bottom. Not persisted.
   */
  scrollAnchor: Record<string, { seq: number; offset: number }>
  /**
   * When the running turn started (#23); the elapsed time is derived, so a remount does not restart it. Not
   * `waitingSince`, which is when the session began waiting for a person and is null while working. Not persisted.
   */
  workingSince: Record<string, number>
  /**
   * A Stop pressed (#1060), keyed to its turn's `workingSince` so a later turn never reads it, and the notice if the
   * tool says it did not take effect. The button says "Stopping…" until the session leaves `working`, as Claude waits too.
   */
  stopping: Record<string, { turn: number | undefined; failed?: string }>
  /** The oldest row on screen: reading back starts here, past what compaction made the model forget. */
  history: Record<string, { oldestSeq: number; more: boolean; loading: boolean }>
  /** Per session and launch card, once opened (#222); in the store, not the card: docs/state-management.md §4. */
  subagentSteps: Record<string, Record<string, SubagentSteps>>
  /**
   * Opened runs of thinking and tool calls (#2007): a run is open when any of its rows' `foldKey`s is here, since it grows
   * at both ends. In the store so a redrawn row or a revisited session keeps it.
   */
  foldOpen: Record<string, Record<string, true>>
  setFoldOpen(sessionId: string, keys: readonly string[], open: boolean): void
  /** The first opening reads them */
  toggleSubagentSteps(sessionId: string, callId: string): void
  loadMoreSubagentSteps(sessionId: string, callId: string): Promise<void>
  /** (#418) Open launch cards read again at once, closed ones when opened. Returns an error, or null when done. */
  trashSubagentSteps(sessionId: string): Promise<string | null>
  restoreSubagentSteps(sessionId: string): Promise<string | null>
  /**
   * Approvals answered and not yet settled (#158), by `inFlightKey`: a second input before the first answer lands would
   * be a "vanished request" and record a command that ran as denied. Keyed by session too: request ids repeat across them.
   */
  approvalsInFlight: Record<string, true>
  /**
   * Attachments uploading (#180). A chip enters the draft only once stored, so the composer refuses to send while this
   * is above zero, or the chip would ride along with the next message.
   */
  uploading: Record<string, number>
  /** `/model` opens the menu local to `SessionSettings`; `at` makes a repeat for the same session a new request. */
  settingsMenuRequest: { sessionId: string; at: number } | null
  /**
   * The session whose composer takes the keyboard next (#528), spent once nothing covers it (`composerFocusAnswer`).
   * Showing another session withdraws it, so it never lands in a session the person left.
   */
  composerFocusFor: string | null
  /**
   * Reads the newest page and merges it (#79, `mergePage`): a first open, `history_synced` and a resync's gap alike.
   * Within a page's range, history wins.
   */
  loadHistory(sessionId: string): Promise<void>
  /** Reads the page holding a search result. */
  loadHistoryAt(sessionId: string, seq: number): Promise<void>
  loadOlder(sessionId: string): Promise<void>
  /** `null` withdraws the request */
  askComposerFocus(sessionId: string | null): void
  requestSettingsMenu(sessionId: string): void
  /** An empty draft is removed */
  setDraft(sessionId: string, draft: Draft): void
  dismissKeptDraft(sessionId: string): void
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** `null`: it was at the bottom */
  setScrollAnchor(sessionId: string, anchor: { seq: number; offset: number } | null): void
  send(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<ChatAttachment | null>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'always',
    scope?: 'session' | 'project',
  ): Promise<void>
  /** Whether the answer reached the host; `false`: a toast was shown (from the composer, `send` puts the text back, #180) */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<boolean>
  interrupt(sessionId: string): Promise<void>
  /** (#290) A refusal or failure is toasted: silence would read as stopped */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  clearBackgroundTasks(sessionId: string): Promise<void>
}
