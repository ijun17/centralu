import { SHUTDOWN_WORDS, type Interruption, type NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'
import type { StopWhy } from '../mail/stop-notices.js'
import { failureSentence, isNetworkFailure, isPlanLimit, planLimitResetAt } from './error-kind.js'

/**
 * How an event changes a session's interruption, or `undefined` when it does not (only the reason: live state is `applyStateHint`'s):
 *
 *   a new turn (working)                       cleared
 *   a network error that ended a running turn  network, with the tool's words
 *   a usage limit that ended a running turn    limit (#1415): the tool's limit event, or an error its words call one;
 *                                              with its reset when known (`limitReset`)
 *   a limit report at rest while a limit       the same stop with the report's reset: the host keeps one current
 *   stop stands                                reset, which the wait follows (`TurnContinue.armAfter`)
 *   any other error, a finished turn           cleared: what shows is the error itself, or nothing to tell
 *   an interrupt nobody here asked for         interrupted
 *   a Stop of ours                             cleared: the person or the Assistant knows
 */
export function interruptionAfter(
  e: NormalizedEvent,
  now: number,
  endedTurn: boolean,
  session: { limit?: SessionLimit | null; interruption?: Interruption | null } = {},
): Interruption | null | undefined {
  const limit = session.limit ?? undefined
  switch (e.type) {
    case 'error':
      /*
       * Only an error that ended a running turn: one at rest (a failed resume, "Could not stop") stopped nothing, and
       * a crash is the process going away, which the screen already says (asleep, `restart_failed`), with no turn to
       * continue that a message would not start anyway.
       */
      if (!e.sessionId || !endedTurn || e.error.code === 'adapter_crashed') return undefined
      if (isNetworkFailure(e.error.message)) return { reason: 'network', at: now, detail: failureSentence(e.error.message).slice(0, 600) }
      return isPlanLimit(e.error.message) ? { reason: 'limit', at: now, detail: failureSentence(e.error.message).slice(0, 600), ...resetOf(e, limit, now) } : null
    case 'limit_reached': {
      if (!e.sessionId) return undefined
      if (endedTurn) return { reason: 'limit', at: now, ...resetOf(e, limit, now) }
      // Codex reports its limits at any time (`account/rateLimits/updated`): one at rest stops nothing, but says the standing limit stop's reset
      const current = session.interruption
      if (current?.reason !== 'limit') return undefined
      // A credits limit has no reset: one said before it is not this limit's
      if (e.credits && current.resetAt !== undefined) {
        const { resetAt: _, ...stop } = current
        return stop
      }
      const resetAt = limitReset(e, limit, now)
      return resetAt !== undefined && resetAt !== current.resetAt ? { ...current, resetAt } : undefined
    }
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
 * A usage limit's reset as the host knows it (#1415): the tool's data first (ISO: Claude's limit event, a Codex rate-limit update the
 * session holds as its `limit`), else the time the tool's words name (`planLimitResetAt`, Codex's "try again at 5:02 PM"). Undefined
 * with neither, and for a credits or spend limit, which no time resets: the `resumeAt` Codex reports beside it is its primary
 * window's, not this limit's. The one source of `Interruption.resetAt` and of a limit wait's time
 */
function limitReset(e: NormalizedEvent, limit: SessionLimit | undefined, now: number): number | undefined {
  if (e.type === 'limit_reached' ? e.credits : limit?.credits) return undefined
  const said = Date.parse((e.type === 'limit_reached' ? e.resumeAt : limit?.resumeAt) ?? '')
  if (Number.isFinite(said)) return said
  return e.type === 'error' ? planLimitResetAt(e.error.message, now) : undefined
}

type SessionLimit = { resumeAt?: string; credits?: boolean }

const resetOf = (e: NormalizedEvent, limit: SessionLimit | undefined, now: number): { resetAt?: number } => {
  const resetAt = limitReset(e, limit, now)
  return resetAt === undefined ? {} : { resetAt }
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

/**
 * One line for an Assistant's list and agent_session (#698), in the words the model reads. A stop Centralu gave up continuing
 * says so here, as the conversation has no line of it (#2360)
 */
export function interruptionWords(i: Interruption): string {
  const gaveUp = i.gaveUpAfter !== undefined ? ` (Centralu gave up continuing it after ${i.gaveUpAfter} ${i.gaveUpAfter === 1 ? 'try' : 'tries'})` : ''
  switch (i.reason) {
    case 'network':
      return `stopped: network error${gaveUp}`
    case 'limit':
      return `stopped: usage limit${gaveUp}`
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

/** A stop Centralu holds to continue by itself once its cause clears (#1415): told as a stop only when that wait ends without going on */
export const heldToContinue = (i: Interruption | null | undefined): boolean => !!i?.autoContinue

/** The line the conversation shows where that note went in */
export const UPDATE_CONTINUE_LINE = 'Centralu was updated during this turn, which stopped it; Centralu continued it on the new version.'

/** The line where a session at rest was told the update stopped its background tasks (#1902) */
export const UPDATE_TASKS_LINE = 'Centralu was updated, which stopped background work of this session; Centralu told the agent so it can start again what it needs.'
