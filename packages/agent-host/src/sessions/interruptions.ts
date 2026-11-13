import { SHUTDOWN_WORDS, type Interruption, type NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'
import type { StopWhy } from '../mail/stop-notices.js'
import { errorKind, failureSentence, isNetworkFailure } from './error-kind.js'

/**
 * How an event changes a session's interruption, or `undefined` when it does not. Live state stays with the event's
 * own state hint (`applyStateHint`); this reads only the reason.
 *
 *   a new turn (working)                       cleared
 *   an error the network caused that ended a   network, with the tool's words
 *   running turn (`endedTurn`)
 *   a usage limit that ended a running turn    limit (#1415): the tool's limit event, or an error its words call one
 *   any other error, a finished turn           cleared: what shows is the error itself, or nothing to tell
 *   an interrupt nobody here asked for         interrupted
 *   a Stop of ours                             cleared: the person or the Assistant knows
 */
export function interruptionAfter(e: NormalizedEvent, now: number, endedTurn: boolean): Interruption | null | undefined {
  switch (e.type) {
    case 'error':
      /*
       * Only an error that ended a running turn: one at rest (a failed resume, "Could not stop") stopped nothing, and
       * a crash is the process going away, which the screen already says (asleep, `restart_failed`), with no turn to
       * continue that a message would not start anyway.
       */
      if (!e.sessionId || !endedTurn || e.error.code === 'adapter_crashed') return undefined
      if (isNetworkFailure(e.error.message)) return { reason: 'network', at: now, detail: failureSentence(e.error.message).slice(0, 600) }
      return errorKind(e.error.message) === 'usage limit' ? { reason: 'limit', at: now, detail: failureSentence(e.error.message).slice(0, 600) } : null
    case 'limit_reached':
      // Only one that ended a turn: Codex reports its limits at any time (`account/rateLimits/updated`), and one at rest stopped nothing
      return e.sessionId && endedTurn ? { reason: 'limit', at: now } : undefined
    case 'turn_complete':
      return null
    case 'state_change':
      if (e.state === 'working') return null
      if (e.state === 'waiting_input' && e.reason === INTERRUPTED_BY_TOOL) return { reason: 'interrupted', at: now }
      if (e.state === 'waiting_input' && e.reason === 'interrupted') return null
      return undefined
    default:
      return undefined
  }
}

/**
 * How long the tool may stay `retrying` before the session is flagged `reconnecting` (#698). Codex waits for the
 * network without end ("Reconnecting... waiting for network", a turn sat `working` for hours); Claude Code gives up after
 * about three minutes and ends in a network error, so this bound mostly catches Codex. Silence alone is never flagged:
 * a session polling CI with 15–40 s sleeps looked frozen and was not (the issue's false alarm).
 */
export const RECONNECTING_FLAG_MS = 5 * 60_000

/**
 * Why the turn this event ended did not finish, for the senders of the questions it left unanswered (docs/plans/turn-owned-by-no-one.md §4.1); null when
 * it ended normally. `interruption` is the session's, after this event: the network is told from it
 */
export function stopOf(e: NormalizedEvent, interruption: Interruption | null | undefined): StopWhy | null {
  switch (e.type) {
    case 'error':
      return interruption?.reason === 'network' ? 'network' : interruption?.reason === 'limit' ? 'limit' : 'error'
    case 'limit_reached':
      return 'limit'
    case 'state_change':
      if (e.state !== 'waiting_input') return null
      return e.reason === INTERRUPTED_BY_TOOL ? 'interrupted' : e.reason === 'interrupted' ? 'stopped' : null
    default:
      return null
  }
}

/** One line for an Assistant's list and agent_session (#698), in the words the model reads */
export function interruptionWords(i: Interruption): string {
  switch (i.reason) {
    case 'network':
      return 'stopped: network error'
    case 'limit':
      return 'stopped: usage limit'
    case 'quit':
      return 'stopped: Centralu quit during its turn'
    case 'shutdown':
      return `stopped: ${SHUTDOWN_WORDS} during its turn`
    case 'interrupted':
      return 'stopped: its tool interrupted the turn'
    case 'reconnecting':
      return `reconnecting to its API for ${Math.max(1, Math.round((Date.now() - i.at) / 60_000))} min`
  }
}

/** A turn that went with its process: Centralu quit, or the system ended under the host (#1397). Both wait for the person's Continue, and neither is a failure of the work */
export const wentWithItsProcess = (i: Interruption | null | undefined): boolean => i?.reason === 'quit' || i?.reason === 'shutdown'

/** The line the conversation shows where that note went in */
export const UPDATE_CONTINUE_LINE = 'Centralu was updated during this turn, which stopped it; Centralu continued it on the new version.'

/** The line where a session at rest was told the update stopped its background tasks (#1902) */
export const UPDATE_TASKS_LINE = 'Centralu was updated, which stopped background work of this session; Centralu told the agent so it can start again what it needs.'
