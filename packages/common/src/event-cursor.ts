/**
 * The one cursor into a host's event stream, for the window and a hub's link (#82, #173, #2163). The gap replays only in
 * the same lifetime (`streamEpoch`) with the host not behind it (`currentSeq < seq`: it came back at the same address).
 */
export type Greeting = { currentSeq: number; streamEpoch?: string | undefined; resyncRequired?: boolean | undefined }

export class EventCursor {
  private seq = 0
  private epoch: string | undefined
  /** False: the next greeting is a first contact */
  private valid = false

  resumeFrom(): { afterSeq: number; streamEpoch?: string } | null {
    if (!this.valid) return null
    return { afterSeq: this.seq, ...(this.epoch ? { streamEpoch: this.epoch } : {}) }
  }

  /** `resync`: the gap cannot be replayed, and the cursor now starts at `currentSeq` */
  greet(g: Greeting): { firstContact: boolean; newLifetime: boolean; resync: boolean } {
    const firstContact = !this.valid
    const sameLifetime = !firstContact && (g.streamEpoch === undefined || this.epoch === undefined || g.streamEpoch === this.epoch) && g.currentSeq >= this.seq
    const resync = firstContact || g.resyncRequired === true || !sameLifetime
    if (resync) this.seq = g.currentSeq
    this.epoch = g.streamEpoch
    this.valid = true
    return { firstContact, newLifetime: !sameLifetime, resync }
  }

  /** The cursor moves before handlers run, so an event is handed on once */
  take(seq: number): boolean {
    if (seq <= this.seq) return false
    this.seq = seq
    return true
  }

  /** The same in every window (#2168); none from a host that names no lifetime, whose numbers restart with it */
  eventId(seq: number): string | undefined {
    return this.epoch === undefined ? undefined : `${this.epoch}:${seq}`
  }

  /** For a new endpoint, whose numbers mean nothing to this cursor */
  forget(): void {
    this.seq = 0
    this.epoch = undefined
    this.valid = false
  }
}
