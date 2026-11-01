import { oneLineText } from '@cc/protocol'
import { awayPhrase, NOT_CONNECTED, NOT_REACHABLE } from '../adapters/contract.js'
import type { RoutedMachine } from './router.js'

/** How a sentence about a machine that is down ends, for the call that was refused (`awaySentence`): none for a bare statement */
export type Tail = string | null
export const TAIL = { tryAgain: 'try again once its link is back', readAgain: 'read it again once its link is back', none: null } as const satisfies Record<string, Tail>

/**
 * `NOT_REACHABLE`, with the attempt a call made to connect the machine (#1532): that it is still under way, or that it
 * failed with the attempt's own words, so the agent can tell a machine that is off from one whose ssh is refused
 */
export const notReachable = (m: Pick<RoutedMachine, 'whyDown'>): string => (m.whyDown ? `${NOT_REACHABLE}; ${oneLineText(m.whyDown, 300)}` : NOT_REACHABLE)

/**
 * Why a machine that is not connected cannot be reached, as the sentence read by the model or the window (#1341). One that
 * nothing here will connect (the person disconnected it, or its Auto reconnect is off and the attempt at the hub's start is
 * over) says so at once and names who can: the person. No call connects a machine by itself
 */
export const awaySentence = (m: Pick<RoutedMachine, 'name' | 'whyDown' | 'waitsForPerson'>, tail: Tail): string =>
  m.waitsForPerson ? `${m.name} ${awayPhrase(NOT_CONNECTED)}, then try again` : `${m.name} is ${notReachable(m)}${tail === null ? '' : `; ${tail}`}`

/** The same for the window, which a person reads: for a machine they disconnected, where to connect it (#1341) */
export const windowAwaySentence = (m: Pick<RoutedMachine, 'name' | 'whyDown' | 'waitsForPerson'>, tail: Tail): string =>
  m.waitsForPerson ? `${m.name} is not connected. Connect it in Settings → Machines, then try again.` : awaySentence(m, tail)

/** How a refusal about a machine that is `away` (its reason, as `awayPhrase` reads it) ends: a machine that waits for the person is not waited for */
export const tryAgainAfter = (away: string): string => (away === NOT_CONNECTED ? 'Try again once the person has connected it.' : 'Try again once its link is back.')
