import type { NormalizedEvent, TokenUsage } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { UnmappedTypes } from '../unmapped.js'
import { KNOWN_EVENTS, KNOWN_STEPS } from './known-steps.js'
import { AgyNormalizer } from './normalize.js'
import { parseLine, STDERR, userLine, type AgyResult } from './stream.js'

/**
 * The `agy` wire, pure: lines in, events out (docs/plans/antigravity-adapter.md §4). It owns no process and no clock. The
 * session core (#1654) writes `startTurn`'s line to the process's stdin, hands every stdout and stderr line and the exit
 * back, and acts on what comes out: it ends the turn, learns the conversation id, stops the process. One instance per
 * process, since `agy` prints `init` once per process and a Stop ends the process (§1.5).
 */

/** How a turn ended; the core says it as a state change, a `turn_complete` or an `error` */
export type TurnEnd =
  | { how: 'complete' }
  /** `byUs`: after a Stop the wire was told of (`stopRequested`); else the tool stopped it itself */
  | { how: 'interrupted'; byUs: boolean }
  | { how: 'failed'; error: { code: 'not_logged_in' | 'internal'; message: string; retryable: boolean } }

export type WireOutput = {
  events: NormalizedEvent[]
  turnEnded?: TurnEnd
  /** The conversation id, said once, at `init`: the session's `externalId` (`agy` prints it nowhere earlier) */
  externalId?: string
  /** The process must be stopped now (SIGINT, §1.5): see `sessionNotFound` */
  stop?: boolean
  /** The conversation asked to resume is not `agy`'s: it would run the turn in a new one (§1.4, §4.4); said once */
  sessionNotFound?: boolean
}

export type AgyWireOptions = {
  sessionId: string
  /** The conversation this process must resume (`--conversation`), or null for a new one */
  resume: string | null
  label?: string
  /** The total token reading the conversation ended its last process with (the new process's readings start from it) */
  usageBefore?: TokenUsage
}

const EMPTY: WireOutput = { events: [] }

export class AgyWire {
  private readonly normalizer: AgyNormalizer
  private readonly unmapped: UnmappedTypes
  private readonly label: string
  private inFlight = 0
  private stopAsked = false
  /** The resume failed: nothing more of this process is the session's */
  private rejected = false
  private loggedOut = false
  private retryable: boolean | undefined

  constructor(private readonly opts: AgyWireOptions) {
    this.label = opts.label ?? 'Antigravity'
    this.normalizer = new AgyNormalizer(opts.sessionId, this.label, opts.usageBefore)
    this.unmapped = new UnmappedTypes(this.label, opts.sessionId, KNOWN_STEPS)
  }

  /** Whether an input was written and its `result` has not come */
  get turnOpen(): boolean {
    return this.inFlight > 0
  }

  /** The line that runs one turn: write it to stdin */
  startTurn(text: string): string {
    this.inFlight++
    return userLine(text)
  }

  /** The core is about to send SIGINT: the `interrupted` result that follows is ours */
  stopRequested(): void {
    this.stopAsked = true
  }

  stdout(line: string): WireOutput {
    if (this.rejected || !line.trim()) return EMPTY
    const frame = parseLine(line)
    switch (frame.event) {
      case 'init':
        return this.init(frame.conversation_id)
      case 'step_update':
        this.unmapped.note(frame.step_update.step_type)
        return { events: this.normalizer.step(frame.step_update) }
      case 'result':
        return this.result(frame.result)
      case 'unknown':
        // An event of ours whose shape changed is as worth a log line as one we do not know
        this.unmapped.note(KNOWN_EVENTS.has(frame.name) ? `${frame.name} (changed shape)` : frame.name)
        return EMPTY
      case 'unparsed':
        this.unmapped.note('(not JSON)')
        return EMPTY
    }
  }

  stderr(line: string): WireOutput {
    if (this.rejected) return EMPTY
    const notFound = STDERR.notFound.exec(line)
    if (notFound && this.opts.resume !== null && notFound[1] === this.opts.resume) return this.refuseResume()
    if (STDERR.loggedOut.test(line)) this.loggedOut = true
    const agyError = STDERR.agyError.exec(line)
    if (agyError?.[1]) this.retryable = retryableOf(agyError[1])
    return EMPTY
  }

  /** The process ended: the calls it left open are closed as failed. Whether that is a crash is the core's rule (a Stop expects it) */
  exit(): WireOutput {
    if (this.rejected) return EMPTY
    return { events: this.normalizer.endTurn('the process ended before this call finished') }
  }

  private init(conversationId: string): WireOutput {
    if (this.opts.resume !== null && conversationId !== this.opts.resume) return this.refuseResume()
    this.normalizer.conversationId = conversationId
    return { events: [], externalId: conversationId }
  }

  /**
   * `agy` answers an unknown `--conversation` with a warning and then starts a new conversation and runs the turn in it. The
   * warning (about 0.4 s in) or an `init` with another id says so; either stops the process, and the session keeps its old
   * `externalId`. What the process prints after (its `result`, its exit) is not the session's.
   */
  private refuseResume(): WireOutput {
    this.rejected = true
    return { events: [], stop: true, sessionNotFound: true }
  }

  private result(r: AgyResult): WireOutput {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const events = this.normalizer.result(r)
    const asked = this.stopAsked
    const retryable = this.retryable
    this.retryable = undefined
    if (r.status === 'SUCCESS') return { events, turnEnded: { how: 'complete' } }
    if (/^interrupted\b/i.test(r.error ?? '')) {
      this.stopAsked = false
      return { events, turnEnded: { how: 'interrupted', byUs: asked } }
    }
    return { events, turnEnded: { how: 'failed', error: this.failure(r, retryable) } }
  }

  private failure(r: AgyResult, retryable: boolean | undefined): { code: 'not_logged_in' | 'internal'; message: string; retryable: boolean } {
    if (this.loggedOut) {
      return { code: 'not_logged_in', message: `${this.label} is not logged in. Run agy in a terminal to log in, then try again.`, retryable: false }
    }
    return { code: 'internal', message: `${this.label}: ${r.error || `the turn ended ${r.status}`}`, retryable: retryable ?? false }
  }
}

/** The changelog says the line carries the status, whether to retry and an id; only the retry flag is read */
function retryableOf(json: string): boolean | undefined {
  try {
    const retryable = asObj(JSON.parse(json)).retryable
    return typeof retryable === 'boolean' ? retryable : undefined
  } catch {
    return undefined
  }
}
