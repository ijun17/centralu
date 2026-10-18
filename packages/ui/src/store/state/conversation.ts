import type {
  QuestionAnswer,
  StoredMessage,
} from '@cc/protocol'
import type { ChatAttachment, ChatItem } from '../transcript.js'

/** Not yet sent. The text and attachments move together — binding only one to the session leaves
 * the pair half fixed */
export type Draft = { text: string; attachments: ChatAttachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** A draft whose session is gone (`ConversationSlice.keptDrafts`); `name` is the session's, when the window knew it */
export type KeptDraft = { sessionId: string; name: string | null; text: string }

/**
 * One launch card's subagent steps on screen (#222).
 *
 *   open     the section is expanded
 *   rows     the steps read so far, oldest first, by their number within the launch (`seq`)
 *   more     the host has more past `rows` than one page carried; live steps wait for those to be read
 *   loading  a page is being read
 *   error    why the last read failed, shown in place of the steps
 */
/**
 * A launch card's steps as the window holds them (#222). `trashed`: how many of them are in the trash without their
 * session (#418), read with the first page; absent until then, and from a host before it.
 */
export type SubagentSteps = { open: boolean; rows: StoredMessage[]; more: boolean; loading: boolean; error: string | null; trashed?: number }

/** One conversation on screen: transcript, drafts, scroll position, history paging, sending and answering. */
export type ConversationSlice = {
  chat: Record<string, ChatItem[]>
  /**
   * Text not yet sent — kept **per session**.
   *
   * It used to be held by the composer component itself. That binds the text to the screen's spot
   * rather than to the session: switching sessions in the focus view reuses the same component, so
   * text written for A was still sitting in B's composer — sending it as is would **go to the
   * wrong session** (confirmed by measurement). Conversely, in the grid, which swaps out
   * components, the text vanished along with the unmounted component.
   *
   * Not put in the store's persisted snapshot. It is not heavy enough to need to survive the app
   * being closed and reopened.
   */
  drafts: Record<string, Draft>
  /**
   * What was being written in a session that is gone (#378 review), oldest first, until the person copies it or puts it
   * away. A session leaves the window without the person asking too: the host deletes an app's agent session once its
   * run is over, and a message that failed to send was put back in the draft just before. Its draft went with it
   * (`forgetSessions`). The text only: attachments were files saved under the session, which went with it.
   */
  keptDrafts: KeptDraft[]
  /**
   * Whether a conversation was left standing at its newest line — **per session** (#31).
   *
   * The flag used to be a ref inside the chat stream, so it was born `true` with every
   * mount, and the grid mounts and unmounts panels as you move around: look at another
   * session, come back, and the panel had decided for itself that you were at the bottom.
   * Fourth time state that belongs to the work has been kept by the view instead (drafts,
   * the elapsed count, expanded folders, this).
   *
   * Per session, and that is the opposite call from expanded folders (#16) on purpose. An
   * open folder is a fact about *the code*, so every session on that repo wants it; where
   * you are in a conversation is a fact about *that conversation*, and you read one at a
   * time.
   *
   * **What is kept is "were you at the bottom", not the offset.** A pixel `scrollTop`
   * restored into a virtualiser that has not measured its rows yet lands *near* the right
   * place — which is the symptom #31 reported, not a cure for it. The bottom needs no
   * measurements to be reachable: it is wherever the content ends.
   *
   * Absent means yes: a conversation nobody has scrolled starts at its newest line. Not
   * persisted — where you had scrolled to is not worth surviving the app closing.
   */
  stickToBottom: Record<string, boolean>
  /**
   * When a conversation was left somewhere other than the bottom, **which row and where in it** it
   * was showing (#61).
   *
   * The comment above, that no pixel offset is kept, is still true — pinning a raw `scrollTop` into
   * a virtualizer that has not yet measured its rows lands only *near* the right place. But that
   * conclusion had been read as "keep nothing at all," and the result was that any conversation not
   * at the bottom restarted from the top every time it was reopened (#61's "the scroll jumps to
   * the top").
   *
   * So what is kept is not a pixel but a **row**: the `seq` of the item spanning the top of the
   * screen, and the offset within that item. `seq` is a fact independent of measurement, so it
   * still points at the same row after remeasuring, and the remaining few pixels are re-fit every
   * frame while rows are being measured.
   *
   * Absent when the conversation was at the bottom — `stickToBottom` already says that, and the
   * bottom needs no measurement to be reached. Not persisted: how far one had read is not worth
   * carrying past the app closing.
   */
  scrollAnchor: Record<string, { seq: number; offset: number }>
  /**
   * When the turn a session is currently running started — the instant, per session.
   *
   * The "Waiting for response" line used to take `Date.now()` on mount and count up from
   * there, so switching views restarted the clock: a turn three minutes old read as if it
   * had just begun (issue #23). The component was holding the wrong half. **Elapsed time is
   * derived; the start instant is the fact.** Keeping the instant here means the count is
   * recomputed rather than resumed, and nothing depends on a component staying alive.
   *
   * Not `waitingSince`, which sounds like the same thing and is the opposite one: that is
   * when the session started waiting for *a human* (approval, input, error), and the
   * reducer sets it to null the moment a session goes back to `working` — precisely when
   * this line is on screen. Two clocks, because there are two directions of waiting.
   *
   * Not persisted. A turn does not survive the app closing.
   */
  workingSince: Record<string, number>
  /**
   * A Stop the person pressed, per session (#1060): the turn it was pressed in (that turn's `workingSince`), and the
   * notice text once the tool says it has not taken effect. Stop is said once the tool confirms it, as Claude now
   * waits too, so the button says "Stopping…" from the click until the session leaves `working`. Keyed to its turn,
   * so a later turn never reads an old Stop, and nothing has to clear it.
   */
  stopping: Record<string, { turn: number | undefined; failed?: string }>
  /**
   * The oldest history point currently on screen, per session.
   * Conversation the model has forgotten to compaction still survives in our store, so this is
   * where reading further back starts from.
   */
  history: Record<string, { oldestSeq: number; more: boolean; loading: boolean }>
  /**
   * The steps of a native subagent, per session and launch card (#222) — present once the person has opened that
   * card's steps, and only then read from the host. Kept here rather than in the card, so a card the virtual list
   * detaches and draws again comes back as it was left (open, loaded), not collapsed and reading again.
   */
  subagentSteps: Record<string, Record<string, SubagentSteps>>
  /** Opens or closes a launch card's steps; the first opening reads them */
  toggleSubagentSteps(sessionId: string, callId: string): void
  /** Reads the next page of a launch card's steps */
  loadMoreSubagentSteps(sessionId: string, callId: string): Promise<void>
  /**
   * Moves a session's subagent steps to the trash, or puts them back (#418), and has its launch cards read them again:
   * an open card reads at once, a closed one when it is opened. Returns an error message, or null when it is done.
   */
  trashSubagentSteps(sessionId: string): Promise<string | null>
  restoreSubagentSteps(sessionId: string): Promise<string | null>
  /**
   * Approval requests that have had a response sent but not yet answered (#158) — `inFlightKey(sessionId, requestId)`
   * → `true`. Keyed by the session too (#683 review): a request id is unique only within a session's process, so two
   * sessions can hold the same one, and an answer in one must not be dropped as a repeat of the other's. If a second input arrives on the same card (two key presses, the card and the rail)
   * before the first response's result reaches the screen, the second response became a "vanished
   * request" and recorded a command that had already run as denied.
   */
  approvalsInFlight: Record<string, true>
  /**
   * The number of attachments currently uploading, per session (#180). A chip only enters the draft
   * once the host has finished storing it, and sending during that window sent only the text —
   * the chip that finished later attached itself to the draft afterward and rode along with the next
   * message. The composer refuses to send while this value is above zero.
   */
  uploading: Record<string, number>
  /**
   * A request to open the session settings menu (model, effort, permissions) (2026-09-07, the
   * `/model` GUI command). The menu's open state is local state on `SessionSettings` — this only
   * carries the signal. `at` is needed so that requesting the same session twice in a row still
   * opens it each time.
   */
  settingsMenuRequest: { sessionId: string; at: number } | null
  /**
   * The session whose composer takes the keyboard next (#528): set where the next thing the person
   * does is type to that session (a session picked in the palette, one just created), and spent by
   * that composer once nothing covers it (`composerFocusAnswer`). Like `settingsMenuRequest`, a
   * signal, not a state of the screen. Showing another session withdraws it (`focusSession`), so a
   * request never lands later in a session the person has left.
   */
  composerFocusFor: string | null
  /**
   * Reads one page of the newest history, merges it with the conversation on screen, and sets the
   * cursor (#79, `mergePage`). The same path serves a session opened for the first time, a re-read
   * that catches up on a conversation continued elsewhere (`history_synced`), and a resync that
   * fills a gap — there used to be a separate `force` that swapped in only for re-reads. Now, within
   * a page's range, history is always the source of truth.
   */
  loadHistory(sessionId: string): Promise<void>
  /** Reads the page containing a search result instead of only the newest history page. */
  loadHistoryAt(sessionId: string, seq: number): Promise<void>
  /** Prepends older conversation (the way to read conversation from before a compaction) */
  loadOlder(sessionId: string): Promise<void>
  /** Asks the session's composer to take the keyboard (#528, `composerFocusFor`); `null` withdraws the request */
  askComposerFocus(sessionId: string | null): void
  /** The `/model` GUI command — opens that session's settings menu (model, effort, permissions) */
  requestSettingsMenu(sessionId: string): void
  /** Attaches something not yet sent to a session (removed if it is empty) */
  setDraft(sessionId: string, draft: Draft): void
  /** Puts away a kept draft (`keptDrafts`), once copied or not wanted */
  dismissKeptDraft(sessionId: string): void
  /** Remember whether the conversation was left at its newest line (#31) */
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** Records the row that was showing when it was left (#61). `null` clears it — meaning it was at the bottom */
  setScrollAnchor(sessionId: string, anchor: { seq: number; offset: number } | null): void
  send(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<ChatAttachment | null>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'always',
    scope?: 'session' | 'project',
  ): Promise<void>
  /** Whether the answer reached the host — `false` means a toast was shown (an answer from the composer has `send` put the text back, #180) */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<boolean>
  interrupt(sessionId: string): Promise<void>
  /** Stops one background task (#290). A refusal or failure is a toast — silence would read as stopped */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  /** Takes the ended background tasks off the session's list (#290) */
  clearBackgroundTasks(sessionId: string): Promise<void>
}
