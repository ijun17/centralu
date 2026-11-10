/**
 * The cursor a client keeps into a host's numbered event stream (#82, #173, #2163): the window's connection to its host
 * and a hub's link to a machine both read events this way, and were kept in step only by a comment.
 *
 * A greeting says whether the gap since the last event can be replayed: only when the cursor is a cursor into this host
 * lifetime (the same `streamEpoch`, or none said) and the host is not behind it (`currentSeq < seq` is a host that came back
 * up at the same address). Otherwise the cursor starts from the host's current number and the client re-reads what it
 * holds. Then each event is taken once, in order: a repeat or a first-met host's old news is dropped.
 */
export type Greeting = { currentSeq: number; streamEpoch?: string | undefined; resyncRequired?: boolean | undefined }

export class EventCursor {
  private seq = 0
  private epoch: string | undefined
  /** Whether `seq` is a cursor into the current host: false means the next greeting is a first contact */
  private valid = false

  /** What a reconnect asks to be replayed from, or nothing on a first contact */
  resumeFrom(): { afterSeq: number; streamEpoch?: string } | null {
    if (!this.valid) return null
    return { afterSeq: this.seq, ...(this.epoch ? { streamEpoch: this.epoch } : {}) }
  }

  /**
   * Reads a greeting. `firstContact`: the cursor held nothing; `newLifetime`: it is not this host lifetime's; `resync`: the
   * gap cannot be replayed (a first contact, the host said so, or another lifetime), and the cursor now starts at `currentSeq`
   */
  greet(g: Greeting): { firstContact: boolean; newLifetime: boolean; resync: boolean } {
    const firstContact = !this.valid
    const sameLifetime = !firstContact && (g.streamEpoch === undefined || this.epoch === undefined || g.streamEpoch === this.epoch) && g.currentSeq >= this.seq
    const resync = firstContact || g.resyncRequired === true || !sameLifetime
    if (resync) this.seq = g.currentSeq
    this.epoch = g.streamEpoch
    this.valid = true
    return { firstContact, newLifetime: !sameLifetime, resync }
  }

  /** Whether an event is new. The cursor moves before its handlers run, so an event is handed on once */
  take(seq: number): boolean {
    if (seq <= this.seq) return false
    this.seq = seq
    return true
  }

  /** Another host (a new endpoint): its numbers mean nothing to this cursor, and the next greeting is a first contact */
  forget(): void {
    this.seq = 0
    this.epoch = undefined
    this.valid = false
  }
}
