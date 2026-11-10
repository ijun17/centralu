/** A later turn of work whose report is paused on the session's own background work, as a report path knows it (#1540) */
export type LaterTurn = {
  /** Centralu's own turn to compact the conversation */
  compaction?: boolean
  /** A message no session sent went into it: the person's, an app's or a script's. Such a turn may be theirs though it reads as the work's */
  othersWrote?: boolean
  /** The person wrote to the session since it owed the report: which of its turns are theirs cannot always be told, and their words are not the caller's */
  personWrote?: boolean
}

/**
 * Whether a later turn of paused work is an update its caller hears at once (#1540): one that said something of its own, in the work's own turn.
 * A turn with no words (a Monitor's look), Centralu's compaction, a turn others wrote into, and every turn once the person wrote to the session tell
 * nothing; the final report still comes when the work ends. The one rule for this host's children (`ChildReports`) and a linked machine's (`LinkedReports`)
 */
export function isPauseUpdate(turn: LaterTurn, words: string): boolean {
  return !turn.compaction && !turn.othersWrote && !turn.personWrote && words.trim() !== ''
}
