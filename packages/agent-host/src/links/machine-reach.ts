import { oneLineText } from '@cc/protocol'
import { awayPhrase, NOT_CONNECTED, NOT_REACHABLE } from '../adapters/contract.js'

/** How long a list of a machine's or a hub's projects may take before it counts as away for the call (#700, #984): a name is looked up on every ask_project, so one slow or half-open link must not hold the rest up; the link's own call timeout is much longer */
export const LOOKUP_MS = 4000

/** How a sentence about a machine that is down ends, for the call that was refused (`awaySentence`): none for a bare statement */
export type Tail = string | null

/** What these sentences read of a machine (`RoutedMachine`'s fields; not imported from `router.ts`, which imports this file) */
type Away = { readonly name: string; readonly whyDown?: string | null; readonly waitsForPerson?: boolean }
export const TAIL = { tryAgain: 'try again once its link is back', readAgain: 'read it again once its link is back', none: null } as const satisfies Record<string, Tail>

/**
 * `NOT_REACHABLE`, with the attempt a call made to connect the machine (#1532): still under way, or failed in the attempt's own
 * words, so an agent can tell a machine that is off from one whose ssh is refused
 */
export const notReachable = (m: Pick<Away, 'whyDown'>): string => (m.whyDown ? `${NOT_REACHABLE}; ${oneLineText(m.whyDown, 300)}` : NOT_REACHABLE)

/**
 * Why a machine that is not connected cannot be reached, as the sentence the model or the window reads (#1341). One nothing
 * here will connect (disconnected by the person, or Auto reconnect off and the attempt at the hub's start over) says so at once
 * and names the person; no call connects it by itself
 */
export const awaySentence = (m: Away, tail: Tail): string =>
  m.waitsForPerson ? `${m.name} ${awayPhrase(NOT_CONNECTED)}, then try again` : `${m.name} is ${notReachable(m)}${tail === null ? '' : `; ${tail}`}`

/** What a call that needs a machine reads of it to reach it (`RoutedMachine`'s fields) */
type Reachable = { readonly reachable: boolean; readonly attemptUnderWay?: boolean; settled?(): Promise<void>; reachForCall?(): Promise<void>; offerAnswered?(): Promise<void> }

/**
 * What an agent's call that needs a machine does first (#1341, #1532): a machine that is down is tried now (`reachForCall`), or
 * waited for, bounded, when an attempt is under way (with nothing trying, answered at once); one that is up, perhaps only just,
 * has answered this connection's offer (`offerAnswered`, bounded), so whether it takes tasks is read from that answer, never as
 * still connecting (#1948 step 6). The caller reads `reachable` after and words a machine still down with `awaySentence`
 */
export const settleForCall = async (m: Reachable): Promise<void> => {
  if (!m.reachable) {
    if (m.reachForCall) await m.reachForCall()
    else if (m.attemptUnderWay) await m.settled?.()
  }
  // Up, and just connected: whether it takes tasks is its answer to this connection's offer, read once it came (#1948 step 6)
  if (m.reachable) await m.offerAnswered?.()
}

/** The same for the window, which a person reads: for a machine they disconnected, where to connect it (#1341) */
export const windowAwaySentence = (m: Away, tail: Tail): string =>
  m.waitsForPerson ? `${m.name} is not connected. Connect it in Settings → Machines, then try again.` : awaySentence(m, tail)

/** How a refusal about a machine that is `away` (its reason, as `awayPhrase` reads it) ends: a machine that waits for the person is not waited for */
export const tryAgainAfter = (away: string): string => (away === NOT_CONNECTED ? 'Try again once the person has connected it.' : 'Try again once its link is back.')

/** A call an agent made, refused because `machine` is `away`: what did not happen (`so`), and when to try again (#1143) */
export const awayRefusal = (machine: string, away: string, so: string): string => `${machine} ${awayPhrase(away)}, so ${so}. ${tryAgainAfter(away)}`
