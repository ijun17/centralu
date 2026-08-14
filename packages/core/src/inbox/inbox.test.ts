import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { afterHandled, buildInbox, countWaiting, nextWaitingSession, type InboxCandidate } from './inbox.js'

const NOW = 1_000_000

const s = (id: string, state: SessionState, opts: Partial<InboxCandidate> = {}): InboxCandidate => ({
  id, projectId: 'p1', name: id, state,
  waitingSince: NOW - 60_000, lastSeq: 1, lastReadSeq: 1, archived: false, ...opts,
})

describe('인박스 정렬 (FR-15)', () => {
  it('긴급도 우선: 승인 → 오류 → 응답대기', () => {
    const inbox = buildInbox([s('a', 'waiting_input'), s('b', 'error'), s('c', 'waiting_approval')], NOW)
    expect(inbox.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('같은 긴급도면 안읽음이 먼저', () => {
    const inbox = buildInbox(
      [s('read', 'waiting_input', { lastSeq: 5, lastReadSeq: 5 }), s('unread', 'waiting_input', { lastSeq: 5, lastReadSeq: 2 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['unread', 'read'])
  })

  it('같은 긴급도·같은 읽음이면 오래 기다린 것부터', () => {
    const inbox = buildInbox(
      [s('new', 'waiting_approval', { waitingSince: NOW - 1000 }), s('old', 'waiting_approval', { waitingSince: NOW - 99_000 })],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['old', 'new'])
  })

  it('working·idle·아카이브는 인박스에 없다', () => {
    const inbox = buildInbox(
      [s('w', 'working'), s('i', 'idle'), s('a', 'waiting_input', { archived: true }), s('ok', 'waiting_input')],
      NOW,
    )
    expect(inbox.map((i) => i.id)).toEqual(['ok'])
  })

  it('limited는 정보성이라 인박스에 넣지 않는다 (사이드바에만 표시)', () => {
    expect(buildInbox([s('l', 'limited')], NOW)).toHaveLength(0)
  })

  it('대기 경과 시간을 계산한다', () => {
    const [item] = buildInbox([s('a', 'waiting_approval', { waitingSince: NOW - 180_000 })], NOW)
    expect(item!.waitingMs).toBe(180_000)
  })

  it('정렬은 결정적이다 (동률이면 id)', () => {
    const items = [s('b', 'waiting_input', { waitingSince: NOW }), s('a', 'waiting_input', { waitingSince: NOW })]
    expect(buildInbox(items, NOW).map((i) => i.id)).toEqual(['a', 'b'])
    expect(buildInbox([...items].reverse(), NOW).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('전역 카운터 (FR-12: 합산 금지)', () => {
  it('승인·오류·응답대기를 분리해 센다', () => {
    const c = countWaiting([
      s('1', 'waiting_approval'), s('2', 'waiting_approval'), s('3', 'waiting_input'),
      s('4', 'waiting_input'), s('5', 'waiting_input'), s('6', 'working'), s('7', 'error'),
    ])
    expect(c).toEqual({ approval: 2, error: 1, input: 3 })
  })

  it('아카이브는 세지 않는다', () => {
    expect(countWaiting([s('a', 'waiting_approval', { archived: true })]).approval).toBe(0)
  })
})

describe('다음 대기로 이동 (FR-17)', () => {
  const inbox = buildInbox([s('a', 'waiting_approval'), s('b', 'error'), s('c', 'waiting_input')], NOW)

  it('현재 없으면 첫 항목', () => {
    expect(nextWaitingSession(inbox, null)).toBe('a')
  })

  it('순환한다', () => {
    expect(nextWaitingSession(inbox, 'a')).toBe('b')
    expect(nextWaitingSession(inbox, 'c')).toBe('a')
  })

  it('현재가 인박스에 없으면 첫 항목 (방금 처리한 경우)', () => {
    expect(nextWaitingSession(inbox, 'zzz')).toBe('a')
  })

  it('빈 인박스면 null', () => {
    expect(nextWaitingSession([], 'a')).toBeNull()
  })

  it('처리 후 자동 이동은 남은 것 중 가장 급한 것', () => {
    expect(afterHandled(inbox, 'a')).toBe('b')
    expect(afterHandled(buildInbox([s('only', 'waiting_input')], NOW), 'only')).toBeNull()
  })
})
