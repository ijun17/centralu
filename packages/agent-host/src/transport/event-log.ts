import { randomUUID } from 'node:crypto'
import type { NormalizedEvent } from '@cc/protocol'

/** Seq assignment and a ring buffer of events (docs/protocol.md §1), kept even while the UI is closed so a reconnect loses no state */
export type LoggedEvent = { seq: number; event: NormalizedEvent }

export class EventLog {
  private buf: LoggedEvent[] = []
  private sizes: number[] = []
  private chars = 0
  private seq = 0
  /**
   * Which host lifetime issued these seq numbers (#82): a seq means something only inside the process that assigned it, and a host that
   * comes back up numbers from 1 again. Without the id, a client holding A1..A3 that reconnects to a host that has broadcast B1..B5 would
   * be handed `A1, A2, A3, B4, B5` as what it missed and lose the rest with no resync (#173 caught only a new host still behind the cursor)
   */
  readonly streamEpoch: string = randomUUID()

  /**
   * `maxChars` bounds what the buffer holds in serialised characters, whatever the event count: a `message_image` carries its
   * whole base64 image, so 2000 events of a screenshot-heavy session could pin hundreds of MB while the host stayed quiet (#392).
   * Past the cap the oldest go first, the newest stays, and a client whose cursor falls out resyncs. The host passes its replay
   * budget (`HostServer`): a hello never replays more, and a character never encodes to fewer UTF-8 bytes than one, so every window
   * that fits the budget on the wire is held here. Unbounded when not given
   */
  constructor(
    private capacity = 2000,
    private maxChars = Number.POSITIVE_INFINITY,
  ) {}

  get currentSeq(): number {
    return this.seq
  }

  get oldestSeq(): number {
    return this.buf[0]?.seq ?? 0
  }

  append(event: NormalizedEvent, chars = JSON.stringify(event).length): LoggedEvent {
    const entry = { seq: ++this.seq, event }
    this.buf.push(entry)
    this.sizes.push(chars)
    this.chars += chars
    // The newest event always stays, however large: dropping it would leave nothing to replay at all
    let drop = 0
    while (drop < this.buf.length - 1 && (this.buf.length - drop > this.capacity || this.chars > this.maxChars)) {
      this.chars -= this.sizes[drop++]!
    }
    if (drop > 0) {
      this.buf.splice(0, drop)
      this.sizes.splice(0, drop)
    }
    return entry
  }

  /**
   * Events after `afterSeq`; `resyncRequired` when the point is outside the buffer and the UI has to reload a snapshot. A cursor
   * (afterSeq > 0) is honoured only with this lifetime's `streamEpoch`: another epoch or none gets a resync (#82), since a 7 cannot be
   * told from another lifetime's 7. A hello with neither is a first contact and gets the whole buffer
   */
  since(afterSeq: number, streamEpoch?: string): { events: LoggedEvent[]; resyncRequired: boolean } {
    if (streamEpoch !== undefined && streamEpoch !== this.streamEpoch) return { events: [], resyncRequired: true }
    if (afterSeq > 0 && streamEpoch === undefined) return { events: [], resyncRequired: true }
    /*
     * A number this instance never assigned (#173): this host came back and numbers from scratch. An empty list would read as
     * "received everything", and nothing would replay until the numbering passed the old value, so a snapshot reload is required
     */
    if (afterSeq > this.seq) return { events: [], resyncRequired: true }
    if (afterSeq === this.seq) return { events: [], resyncRequired: false }
    if (this.buf.length === 0) return { events: [], resyncRequired: afterSeq < this.seq }
    if (afterSeq > 0 && afterSeq < this.oldestSeq - 1) return { events: [], resyncRequired: true }
    if (afterSeq === 0 && this.oldestSeq > 1) return { events: [], resyncRequired: true }
    return { events: this.buf.filter((e) => e.seq > afterSeq), resyncRequired: false }
  }
}
