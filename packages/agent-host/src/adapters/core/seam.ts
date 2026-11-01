import type { NormalizedEvent } from '@cc/protocol'
import type { AgentProcess } from '../contract.js'
import type { InputReceipt } from '../input-receipts.js'
import type { GateRequests } from './gate.js'
import type { ToolLaunch } from './tool-process.js'

/**
 * The seam between the session core and one tool (docs/plans/session-core.md §4, #1654): the core (`ledger.ts`) drives a
 * tool through `ToolWire`, and the tool answers through `CoreIo` and the `RunningTurn` it was handed. The core owns the
 * phase, the queue, the input receipts, the Stop and its timer, the exit (crash or asleep) and the process; the wire owns
 * the frames and what they mean. The decision order (PR 8) and the event hygiene (PR 9) are not in the seam yet: until
 * they move, a wire keeps its cards and only hears from the core when to release them. A tool that takes input mid-turn
 * (Codex, Claude) names its own turns, so it has a seam of its own (`MidTurnWire`, `mid-turn-ledger.ts`).
 */

export type ProtocolErrorOf = Extract<NormalizedEvent, { type: 'error' }>['error']

/** What the core hands a wire to write: one input */
export type TurnInput = {
  /** The receipt's id (`InputReceipts`), for `CoreIo.inputAccepted` */
  readonly id: string
  readonly text: string
  /** The turn Centralu started to compact the session (`SessionEvents.sendCompact`), never the person's `/compact` */
  readonly compact: boolean
}

/**
 * How a turn ended, as the tool said it (§2.11: each tool keeps its mapping until Q7's change makes them one):
 * - `complete`: the turn's answer came; its inputs complete; `turn_complete`
 * - `interrupted`: the tool ended it unfinished; a Stop asked in it makes it `interrupted` and fails its inputs (§2.3),
 *   otherwise it is "interrupted by the tool" and its inputs complete
 * - `failed`: an `error` event with `error`; `inputError` fails the inputs, null completes them (the input went in and the
 *   tool answered it, as an ACP refusal does)
 */
export type TurnEnding =
  | { how: 'complete' }
  | { how: 'interrupted' }
  | { how: 'failed'; error: ProtocolErrorOf; inputError: Error | null }

/** The turn the core started for a wire: what it may read of it, and how it ends it */
export interface RunningTurn {
  /** A Stop was asked in this turn: what the tool asks after it is not asked of the person, and its end is ours */
  readonly stopAsked: boolean
  /**
   * The tool ended the turn. `events`: the tool's own events for its end (usage, a notice), emitted after the calls the turn
   * left open are closed and before the ending's own event; called only when the end is taken, so nothing is counted for a
   * turn the session no longer runs. An end for a turn already over (a late answer, a closed session) is ignored
   */
  end(ending: TurnEnding, events?: () => readonly NormalizedEvent[]): void
}

/** What a wire gets back from the core, one per process (a wire's late line from a replaced process changes nothing) */
export interface CoreIo {
  /** The process this io belongs to, tapped (frames recorded) */
  readonly process: AgentProcess
  /** The gate requests of the session (`SessionProcess.gates`): a Stop, a new process, an exit and the close deny them */
  readonly gates: GateRequests
  emit(event: NormalizedEvent): void
  /** The tool took the input (receipts): ACP at its write, since `session/prompt` has no earlier answer (§2.3) */
  inputAccepted(inputId: string): void
  /** An id the tool said after `open` (`agy`: in `init`, after the first input): every later launch goes on with it */
  externalId(id: string): void
}

/** What the core needs from a tool: its wire. One per session */
export interface ToolWire {
  /** "Cursor", "OpenCode", "Antigravity": for messages */
  readonly label: string
  /** How to install the tool, said when a new process finds it gone (`toolNotInstalled`) */
  readonly install?: string
  readonly turns: {
    /** A Stop ends the process (`agy`: SIGINT, through `SessionProcess.interrupt`); the next input starts a new one on the same conversation */
    readonly interruptEndsProcess: boolean
  }
  /** The process to start for this conversation, asked again for every new process (§5.1) */
  readonly launch: ToolLaunch
  /** Opens or resumes the conversation on a started process; the id it answers is the conversation's (null: said later) */
  open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }>
  /** Writes one input, sent once the turn before it has ended; the turn it starts ends through `turn.end` */
  startTurn(input: TurnInput, turn: RunningTurn): void
  /** The tool's own Stop (ACP: `session/cancel`). A tool whose Stop ends the process has none: the core signals it */
  interrupt?(): void
  /**
   * The turn is over, whichever way (its end, an exit, the close): the calls it left open end (`why`: the result's text when
   * the session closed under them), and whatever the wire held for that turn is let go
   */
  turnOver(why?: string): void
  /** Answers every approval card still open as denied, with its `approval_resolved` (on a Stop, a turn's end, an exit, the close) */
  releaseCards(): void
  /** The conversation's end on this process (`session/close`), before the core stops the process. `turnRunning`: closed mid-turn */
  close(opts: { turnRunning: boolean }): Promise<void>
}

/** One input to a tool that takes input mid-turn: its words, and its receipt when the sender tracks it (`sendTracked`) */
export type MidTurnInput = { readonly text: string; readonly receipt: InputReceipt | null }

/** How a turn the tool named ended, as it said: the core says it to the host and settles the inputs bound to it */
export type ToolTurnEnding = { how: 'complete' | 'interrupted' } | { how: 'failed'; error: ProtocolErrorOf }

/**
 * How a Stop of the running turn is confirmed (§2.4), one value per tool, so making the tools agree is a change of it: the tool's
 * answer to the interrupt, or the turn's end, within `ms`, with `notice` (`seconds`: the bound) said when neither has come
 */
export type StopConfirmation = { readonly ms: number; notice(seconds: number): string }

/**
 * What the core needs from a tool that takes input mid-turn (Codex, Claude). The tool merges an input into the turn it runs or
 * starts a turn for it, and names its turns, so the core binds each input to the turn the tool says took it instead of
 * beginning turns itself (`MidTurnLedger`). The wire holds the ledger and tells it what the tool said; it owns its
 * connection and says when it ended (`MidTurnLedger.exited`). A wire that writes its own inputs (Claude: the SDK's input
 * stream, which a quiet input, a held `/goal` and the sign-in race also go through) has no `open`, `hasConversation`, `write`
 * and `refusal`: its conversation exists from the start, and it takes receipts from the ledger (`track`) instead.
 */
export interface MidTurnWire {
  /** "Codex": for messages */
  readonly label: string
  /** Opens or resumes the conversation */
  open?(): Promise<void>
  /** The tool named the conversation while it opens: from then a turn may run in it, so a Stop no longer takes back what waits */
  hasConversation?(): boolean
  /**
   * Writes inputs as one message: several only when they `queued` behind a blocking turn, sent then as they are. `answer`
   * settles with the tool's answer and rejects when it refused; `blocking`: they started a turn no input may join until it
   * ends (Codex's /compact and /review)
   */
  write?(inputs: readonly MidTurnInput[], queued: boolean): { answer: Promise<unknown>; blocking?: boolean }
  /** The error said for a write the tool refused */
  refusal?(err: Error): ProtocolErrorOf
  /** Asks the tool to stop one of its turns; rejects when it refused. `tracked`: a tracked input waited when the Stop came */
  interrupt(toolTurnId: string, tracked: boolean): Promise<unknown>
  /** How a Stop of the running turn is confirmed; none: by the turn's end only, with no bound (Codex, §9.2) */
  readonly stop?: StopConfirmation
  /** The tool refused a Stop under a bound: the turn goes on, and however it ends is its own ending (Claude's normalizer) */
  stopRefused?(): void
  /** A Stop with no turn running: what the tool is still told (Claude: the interrupt, which cancels what its stream holds) */
  idleStop?(tracked: boolean): void
  /** Work of the wire's own that an exit would lose, besides the ledger's (Claude: a queued or unanswered message, a card, background work) */
  inFlight?(): boolean
  /** What a tracked input fails with when the process ends under it; none: "The session process ended before the parent note finished" */
  readonly exitWords?: string
  /** A Stop: the approval cards still open are denied, and the calls this session made are cancelled (`tracked` as for `interrupt`) */
  releaseCards(tracked: boolean): void
  /** The connection ended (an exit, the close): what lived in it ends with it */
  connectionEnded(): void
  /** The conversation's end: the connection closes */
  close?(): Promise<void>
  /** Lets go of the connection without closing it (a host swap) */
  detach?(): Promise<void>
}

