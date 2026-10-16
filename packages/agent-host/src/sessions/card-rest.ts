import { isInTurn, nextStateFor, SessionState, type NormalizedEvent } from '@cc/protocol'

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
 * The rests are written down (`RestRecord`, one app setting) because the card outlives a host swap: the keeper keeps
 * the process, the next host adopts it with the session still waiting_approval, and the tool raises the card again.
 * Remembered only in memory, that card read as one inside a turn, and answering it ended in working once more.
 */
export class CardRests {
  private rests = new Map<string, SessionState>()
  /**
   * Sessions the host just gave input to, and when: a turn is asked for even before the tool says so, and a card it
   * raises first (a tool that does not announce its turn) belongs to that turn, not to a rest. It lapses after
   * `ASK_WINDOW_MS` without a word from the tool, so input the tool never took does not hide a later card's rest.
   */
  private asked = new Map<string, number>()

  constructor(
    private readonly record: RestRecord | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * At a host's start: the rests the previous host wrote, kept for the sessions `keep` names (their process is adopted
   * with the card still standing) and dropped for the rest.
   */
  restore(keep: (sessionId: string) => boolean): void {
    const saved = this.record?.load() ?? {}
    for (const [id, rest] of Object.entries(saved)) {
      const parsed = SessionState.safeParse(rest)
      if (parsed.success && keep(id)) this.rests.set(id, parsed.data)
    }
    if (Object.keys(saved).length !== this.rests.size) this.write()
  }

  /** The host delivered input to the session: whatever comes next is that turn's */
  turnAsked(sessionId: string): void {
    this.asked.set(sessionId, this.now())
    this.drop(sessionId)
  }

  /** Called with each event of a session, and the state it was in before the event */
  note(e: NormalizedEvent, sessionId: string, before: SessionState): void {
    if (e.type === 'approval_request' || e.type === 'question_request') {
      if (!isInTurn(before) && !this.turnPending(sessionId) && !this.rests.has(sessionId)) {
        this.rests.set(sessionId, before)
        this.write()
      }
      return
    }
    // Anything else that moves the state (a turn starting or ending, an error) leaves no rest to go back to, and the
    // tool has now spoken for the turn it was asked for
    if (e.type !== 'approval_resolved' && e.type !== 'question_resolved' && nextStateFor(e) !== null) this.forget(sessionId)
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
    this.drop(s.id)
    return rest !== undefined && s.state === 'working' ? rest : null
  }

  /** The session's state was set by the host itself (a resume, a tool change, a card's rest), or it is gone */
  forget(sessionId: string): void {
    this.drop(sessionId)
    this.asked.delete(sessionId)
  }

  private turnPending(sessionId: string): boolean {
    const at = this.asked.get(sessionId)
    if (at === undefined) return false
    if (this.now() - at < ASK_WINDOW_MS) return true
    this.asked.delete(sessionId)
    return false
  }

  private drop(sessionId: string): void {
    if (this.rests.delete(sessionId)) this.write()
  }

  private write(): void {
    this.record?.save(Object.fromEntries(this.rests))
  }
}

/**
 * How long input stands for a turn the tool has not announced. Claude and Codex announce theirs at once (a
 * state_change working on send, `turn/started`); this bounds only a tool that never does.
 */
export const ASK_WINDOW_MS = 60_000

/** Where the rests are written: the whole set, small, under one key */
export type RestRecord = { load(): Record<string, unknown>; save(rests: Record<string, SessionState>): void }

/** The app setting that holds them, so no store migration is needed and an older host simply ignores it */
export const CARD_RESTS_KEY = 'card_rests'

/** A `RestRecord` on the store's app settings */
export function appSettingRests(settings: { appSetting(key: string): string | null; setAppSetting(key: string, value: string): void; deleteAppSetting(key: string): void }): RestRecord {
  return {
    load: () => {
      try {
        const v = JSON.parse(settings.appSetting(CARD_RESTS_KEY) ?? '{}') as unknown
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    },
    save: (rests) => (Object.keys(rests).length ? settings.setAppSetting(CARD_RESTS_KEY, JSON.stringify(rests)) : settings.deleteAppSetting(CARD_RESTS_KEY)),
  }
}
