import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { EventLog } from './event-log.js'

const ev = (text: string): NormalizedEvent => ({ type: 'message_delta', sessionId: 's1', role: 'assistant', text })

describe('EventLog: 재연결 복원 (T3-1 완료 기준)', () => {
  it('seq를 1부터 단조 증가로 부여한다', () => {
    const log = new EventLog()
    expect(log.append(ev('a')).seq).toBe(1)
    expect(log.append(ev('b')).seq).toBe(2)
    expect(log.currentSeq).toBe(2)
  })

  it('연결→이벤트 N개→끊김→afterSeq 재접속→유실분만 수신', () => {
    const log = new EventLog()
    log.append(ev('1'))
    log.append(ev('2')) // 여기까지 UI가 받았다고 가정
    log.append(ev('3')) // UI 끊긴 동안 발생
    log.append(ev('4'))

    const { events, resyncRequired } = log.since(2)
    expect(resyncRequired).toBe(false)
    expect(events.map((e) => e.seq)).toEqual([3, 4])
    expect((events[0]!.event as { text: string }).text).toBe('3')
  })

  it('최신까지 받았으면 빈 배열', () => {
    const log = new EventLog()
    log.append(ev('1'))
    expect(log.since(1)).toEqual({ events: [], resyncRequired: false })
  })

  it('afterSeq 0이면 버퍼 전체를 준다 (첫 연결)', () => {
    const log = new EventLog()
    log.append(ev('1'))
    log.append(ev('2'))
    expect(log.since(0).events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('버퍼를 넘어간 지점 요청은 resyncRequired', () => {
    const log = new EventLog(3)
    for (let i = 0; i < 10; i++) log.append(ev(String(i)))
    expect(log.oldestSeq).toBe(8) // 8,9,10만 남음
    const r = log.since(2)
    expect(r.resyncRequired).toBe(true)
    expect(r.events).toEqual([])
  })

  it('오래 끊겼다가 첫 연결처럼 붙어도 유실을 알린다', () => {
    const log = new EventLog(2)
    for (let i = 0; i < 5; i++) log.append(ev(String(i)))
    expect(log.since(0).resyncRequired).toBe(true)
  })

  /*
   * #173: host가 같은 주소로 다시 뜨면 번호가 처음부터 매겨진다. 옛 클라이언트가 옛 번호를 들고 오면, 빈 목록만 주고
   * 재동기화를 요구하지 않던 동안 새 host의 번호가 옛 값을 넘을 때까지 아무것도 재생되지 않았다.
   */
  it('매긴 적 없는 번호를 들고 오면(host가 다시 떴다) 재동기화를 요구한다', () => {
    const log = new EventLog()
    for (let i = 0; i < 3; i++) log.append(ev(String(i)))
    expect(log.since(5000)).toEqual({ events: [], resyncRequired: true })
    expect(log.since(3)).toEqual({ events: [], resyncRequired: false })
  })

  it('용량을 넘으면 오래된 것부터 버린다', () => {
    const log = new EventLog(3)
    for (let i = 0; i < 5; i++) log.append(ev(String(i)))
    expect(log.since(4).events.map((e) => e.seq)).toEqual([5])
  })
})
