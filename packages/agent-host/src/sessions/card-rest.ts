import { isInTurn, nextStateFor, type NormalizedEvent, type SessionState } from '@cc/protocol'

/**
 * The rest an adapter's card was raised in, so answering it goes back there (#428).
 *
 * A card blocks the session wherever it comes from (waiting_approval), and answering the last one reads as "back to
 * work" (working). Inside a turn that is true: the tool call that asked goes on, and the turn's end follows. A card
 * raised while no turn ran (a background agent asking after its turn ended, say) has no turn to go back to, and the
 * session sat in working with nothing to end it: busy to the keeper, an update and sleep, and "stopped by quit" at the
 * next start. The host's own cards already close into their rest (`restAfterCard`, host-cards.ts); this does the same
 * for an adapter's.
 *
 * Kept in memory only: a host that starts again has neither the card nor the rest.
 */
export class CardRests {
  private rests = new Map<string, SessionState>()

  /** Called with each event of a session, and the state it was in before the event */
  note(e: NormalizedEvent, sessionId: string, before: SessionState): void {
    if (e.type === 'approval_request' || e.type === 'question_request') {
      if (!isInTurn(before) && !this.rests.has(sessionId)) this.rests.set(sessionId, before)
      return
    }
    // Anything else that moves the state (a turn starting or ending, an error) leaves no rest to go back to
    if (e.type !== 'approval_resolved' && e.type !== 'question_resolved' && nextStateFor(e) !== null) this.rests.delete(sessionId)
  }

  /**
   * After a resolve: the rest to go back to, when the session was put to work by answering its last card and no turn
   * ran meanwhile. Taken once.
   */
  restAfter(
    e: NormalizedEvent,
    s: { id: string; state: SessionState; pendingApproval: unknown; pendingQuestions: readonly unknown[] },
  ): SessionState | null {
    if (e.type !== 'approval_resolved' && e.type !== 'question_resolved') return null
    if (s.pendingApproval || s.pendingQuestions.length > 0) return null
    const rest = this.rests.get(s.id)
    this.rests.delete(s.id)
    return rest !== undefined && s.state === 'working' ? rest : null
  }

  forget(sessionId: string): void {
    this.rests.delete(sessionId)
  }
}
