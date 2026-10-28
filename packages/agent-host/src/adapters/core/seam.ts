import type { NormalizedEvent } from '@cc/protocol'
import type { AgentProcess } from '../contract.js'
import type { GateRequests } from './gate.js'
import type { ToolLaunch } from './tool-process.js'

/**
 * The seam between the session core and one tool (docs/plans/session-core.md §4, #1654): the core (`ledger.ts`) drives a
 * tool through `ToolWire`, and the tool answers through `CoreIo` and the `RunningTurn` it was handed. The core owns the
 * phase, the queue, the input receipts, the Stop and its timer, the exit (crash or asleep) and the process; the wire owns
 * the frames and what they mean. The decision order (PR 8) and the event hygiene (PR 9) are not in the seam yet: until
 * they move, a wire keeps its cards and only hears from the core when to release them.
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
    /** false: an input sent while a turn runs waits for its end (ACP, `agy`); true: it goes to the tool at once */
    readonly midTurnInput: boolean
    /** A Stop ends the process (`agy`: SIGINT, through `SessionProcess.interrupt`); the next input starts a new one on the same conversation */
    readonly interruptEndsProcess: boolean
    /** The tool ends the turn after a Stop, so the confirmation timer applies (§2.4; Codex: false until §9.2's change) */
    readonly confirmsStop: boolean
  }
  /** The process to start for this conversation, asked again for every new process (§5.1) */
  readonly launch: ToolLaunch
  /** Opens or resumes the conversation on a started process; the id it answers is the conversation's (null: said later) */
  open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }>
  /** Writes one input; the turn ends through `turn.end` */
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
