import { bubbleLook } from '../../../components/bubble.js'

/**
 * The person's bubble on the right, in one place for the row (ChatRow) and its pinned copy at the top (StickyUser). A message
 * that came from another session, an app or a script (relayed) keeps the shape of the person's bubble and takes the other
 * side's colours (`bubbleLook`, #1629), so a message that is not the person's reads as the other side's.
 */
export function isRelayed(item: { from?: unknown; fromApp?: unknown; fromScript?: unknown }): boolean {
  return Boolean(item.from || item.fromApp || item.fromScript)
}

/** The colour classes of the person's bubble, or of a relayed one */
export const mineBubbleLook = (relayed: boolean): string => bubbleLook(relayed ? 'theirs' : 'mine')

/** Markers for the person's bubble and for a relayed one (tests and the replay scenarios read them; the edges are tokens now, not a stylesheet override) */
export function mineBubbleAttrs(relayed: boolean): { 'data-mine-bubble': ''; 'data-relayed'?: '' } {
  return relayed ? { 'data-mine-bubble': '', 'data-relayed': '' } : { 'data-mine-bubble': '' }
}
