import type { NormalizedEvent } from '@cc/protocol'

/**
 * seq assignment + ring buffer (docs/protocol.md §1).
 * The core device that keeps "reconnecting from losing state" — the host keeps logging events
 * even while the UI is closed.
 */
export type LoggedEvent = { seq: number; event: NormalizedEvent }

export class EventLog {
  private buf: LoggedEvent[] = []
  private seq = 0

  constructor(private capacity = 2000) {}

  get currentSeq(): number {
    return this.seq
  }

  /** The oldest seq still in the buffer (0 if none) */
  get oldestSeq(): number {
    return this.buf[0]?.seq ?? 0
  }

  append(event: NormalizedEvent): LoggedEvent {
    const entry = { seq: ++this.seq, event }
    this.buf.push(entry)
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity)
    return entry
  }

  /**
   * Returns events after afterSeq.
   * If resyncRequired=true, the request point is outside the buffer and cannot be resent, so the
   * UI has to reload a snapshot.
   */
  since(afterSeq: number): { events: LoggedEvent[]; resyncRequired: boolean } {
    /*
     * Received a number this instance never assigned (#173) — this host came back up and is
     * numbering from scratch (the web and dev modes come back up at the same address and token).
     * Returning only an empty list would make the client think it had received everything, and
     * nothing would get replayed until the new host's numbering passed the old value. There is no
     * way to know what was missed, so a snapshot reload is required instead.
     */
    if (afterSeq > this.seq) return { events: [], resyncRequired: true }
    if (afterSeq === this.seq) return { events: [], resyncRequired: false }
    if (this.buf.length === 0) return { events: [], resyncRequired: afterSeq < this.seq }
    // If the request point has been pushed out of the buffer, a resync is required
    if (afterSeq > 0 && afterSeq < this.oldestSeq - 1) return { events: [], resyncRequired: true }
    if (afterSeq === 0 && this.oldestSeq > 1) return { events: [], resyncRequired: true }
    return { events: this.buf.filter((e) => e.seq > afterSeq), resyncRequired: false }
  }
}
