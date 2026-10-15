import type { Interruption, NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'

/**
 * Why a turn did not run to its end (#698), read from the event that ended it. Tool-neutral: both adapters hand the
 * tool's own sentence on in `error.message`, so the words below are matched there rather than each adapter growing
 * its own field.
 *
 * Measured, the sentences a turn failed with after the tool's own retries:
 *
 *   Claude Code   "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"
 *                 "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
 *                 "API Error: No response from API (waited 3m). If a proxy or gateway …"
 *                 "API Error: Connection lost while your computer was asleep"
 *                 "API Error: Your computer went to sleep mid-response. The response above may be incomplete."
 *                 (the real store, 2026-10-14/15; the CLI retried `api_retry` ten times, about three minutes, first)
 *   Codex         "stream disconnected before completion: failed to lookup address information: nodename nor servname
 *                 provided, or not known", "… Transport error: network error: error decoding response body",
 *                 "… Transport error: timeout", "Connection failed: error sending request"
 *                 (host.log, the reasons of `Reconnecting... n/5`; a turn that gives up ends with the last one)
 *
 * A 401, a 400 for a model, a usage limit and the like are not here: continuing would only fail again the same way.
 * The words are the API's own sentences, so a generic phrase ("connection closed", "network error") is matched only
 * inside one: a tool's own failure can say it about something else (an MCP server, a dev server it ran).
 */
const NETWORK_WORDS = [
  /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/,
  /API Error: (No response from API|Can't reach the API server|Connection (refused|lost|reset|error)|Request timed out)/i,
  /computer (went to sleep|was asleep)/i,
  /stream disconnected before completion/i,
  /failed to lookup address information/i,
  /Connection failed: error sending request/i,
  /waiting for network/i,
]

/**
 * The tool's own sentence, without the end of the CLI's stderr a crash carries (`. stderr: …`, the SDK's and
 * `withStderrTail`'s): that tail is whatever the process printed last, and a word in it says nothing of this turn.
 */
export function failureSentence(message: string): string {
  return message.split(/(?:^|[.\s])stderr:/)[0]!.trim()
}

export function isNetworkFailure(message: string): boolean {
  const sentence = failureSentence(message)
  return NETWORK_WORDS.some((w) => w.test(sentence))
}

/**
 * How an event changes a session's interruption, or `undefined` when it does not. Live state stays with the event's
 * own state hint (`applyStateHint`); this reads only the reason.
 *
 *   a new turn (working)                       cleared
 *   an error the network caused that ended a   network, with the tool's words
 *   running turn (`endedTurn`)
 *   any other error, a finished turn           cleared: what shows is the error itself, or nothing to tell
 *   an interrupt nobody here asked for         interrupted
 *   a Stop of ours                             cleared: the person or the orchestrator knows
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
      return isNetworkFailure(e.error.message) ? { reason: 'network', at: now, detail: failureSentence(e.error.message).slice(0, 600) } : null
    case 'turn_complete':
      return null
    case 'state_change':
      if (e.state === 'working') return null
      if (e.state === 'waiting_input' && e.reason === INTERRUPTED_BY_TOOL) return { reason: 'interrupted', at: now }
      if (e.state === 'waiting_input' && e.reason === 'interrupted') return null
      return undefined
    case 'message_delta':
    case 'tool_call':
      // Output is a turn running: whatever stopped the last one is over
      return null
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

/** The interruptions that outlive the process and are stored; `reconnecting` describes a running one */
export function storedInterruption(i: Interruption | null | undefined): Interruption | null {
  return i && i.reason !== 'reconnecting' ? i : null
}

/** One line for an orchestrator's list and agent_session (#698), in the words the model reads */
export function interruptionWords(i: Interruption): string {
  switch (i.reason) {
    case 'network':
      return 'stopped: network error'
    case 'quit':
      return 'stopped: Centralu quit during its turn'
    case 'interrupted':
      return 'stopped: its tool interrupted the turn'
    case 'reconnecting':
      return `reconnecting to its API for ${Math.max(1, Math.round((Date.now() - i.at) / 60_000))} min`
  }
}
