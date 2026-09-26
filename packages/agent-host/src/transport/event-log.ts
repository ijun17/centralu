import type { NormalizedEvent } from '@cc/protocol'

/**
 * seq 부여 + 링 버퍼 (docs/protocol.md §1).
 * "재연결이 상태 유실이 되지 않게" 하는 핵심 장치 — UI가 꺼져 있어도 host는 계속 적재한다.
 */
export type LoggedEvent = { seq: number; event: NormalizedEvent }

export class EventLog {
  private buf: LoggedEvent[] = []
  private seq = 0

  constructor(private capacity = 2000) {}

  get currentSeq(): number {
    return this.seq
  }

  /** 버퍼에 남아 있는 가장 오래된 seq (없으면 0) */
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
   * afterSeq 이후 이벤트를 돌려준다.
   * resyncRequired=true면 버퍼 밖이라 재전송 불가 → UI는 스냅샷을 다시 로드해야 한다.
   */
  since(afterSeq: number): { events: LoggedEvent[]; resyncRequired: boolean } {
    /*
     * 매긴 적 없는 번호를 들고 왔다 (#173) — 이 host가 다시 떠 번호를 처음부터 매기는 중이다(웹·개발 모드는 같은 주소와
     * 토큰으로 다시 뜬다). 빈 목록만 돌려주면 클라이언트는 다 받은 줄 알고, 새 host의 번호가 옛 값을 넘을 때까지 아무것도
     * 재생받지 못한다. 무엇을 놓쳤는지 알 수 없으니 스냅샷을 다시 읽게 한다.
     */
    if (afterSeq > this.seq) return { events: [], resyncRequired: true }
    if (afterSeq === this.seq) return { events: [], resyncRequired: false }
    if (this.buf.length === 0) return { events: [], resyncRequired: afterSeq < this.seq }
    // 요청 지점이 버퍼에서 밀려났으면 재동기화 필요
    if (afterSeq > 0 && afterSeq < this.oldestSeq - 1) return { events: [], resyncRequired: true }
    if (afterSeq === 0 && this.oldestSeq > 1) return { events: [], resyncRequired: true }
    return { events: this.buf.filter((e) => e.seq > afterSeq), resyncRequired: false }
  }
}
