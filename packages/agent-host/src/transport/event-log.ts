import { randomUUID } from 'node:crypto'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * seq 부여 + 링 버퍼 (docs/protocol.md §1).
 * "재연결이 상태 유실이 되지 않게" 하는 핵심 장치 — UI가 꺼져 있어도 host는 계속 적재한다.
 */
export type LoggedEvent = { readonly seq: number; readonly event: NormalizedEvent }

export type ReplayWindow = { readonly events: readonly LoggedEvent[]; readonly resyncRequired: boolean }

export class EventLog {
  private readonly buf: LoggedEvent[]
  readonly streamEpoch = randomUUID()
  private seq = 0
  private count = 0

  constructor(private readonly capacity = 2000) {
    this.buf = new Array<LoggedEvent>(Math.max(1, Math.trunc(capacity)))
  }

  get currentSeq(): number {
    return this.seq
  }

  /** 버퍼에 남아 있는 가장 오래된 seq (없으면 0) */
  get oldestSeq(): number {
    return this.count === 0 ? 0 : this.seq - this.count + 1
  }

  append(event: NormalizedEvent): LoggedEvent {
    const entry = { seq: this.seq + 1, event }
    this.seq = entry.seq
    this.buf[(entry.seq - 1) % this.buf.length] = entry
    this.count = Math.min(this.count + 1, this.buf.length)
    return entry
  }

  /**
   * afterSeq 이후 이벤트를 돌려준다.
   * resyncRequired=true면 버퍼 밖이라 재전송 불가 → UI는 스냅샷을 다시 로드해야 한다.
   */
  since(afterSeq: number, streamEpoch: string = this.streamEpoch): ReplayWindow {
    if (streamEpoch !== this.streamEpoch) return { events: [], resyncRequired: true }
    if (!Number.isInteger(afterSeq) || afterSeq < 0) return { events: [], resyncRequired: true }
    if (afterSeq === this.seq) return { events: [], resyncRequired: false }
    if (afterSeq > this.seq) return { events: [], resyncRequired: true }
    if (this.count === 0) return { events: [], resyncRequired: false }
    if (afterSeq < this.oldestSeq - 1) return { events: [], resyncRequired: true }

    const events: LoggedEvent[] = []
    for (let seq = afterSeq + 1; seq <= this.seq; seq += 1) {
      const entry = this.buf[(seq - 1) % this.buf.length]
      if (entry) events.push(entry)
    }
    return { events, resyncRequired: false }
  }
}
