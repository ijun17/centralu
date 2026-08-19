import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, allDoneNotification, badgeCount, notificationFor } from './notify.js'

const s = (state: SessionState, name = '세션') => ({ id: 's1', name, state })
const bg = { appFocused: false }

describe('즉시 알림 (승인·오류만)', () => {
  it('승인 대기로 전이하면 알린다', () => {
    expect(notificationFor(s('waiting_approval'), 'working', bg)).toMatchObject({ kind: 'approval' })
  })

  it('오류로 전이하면 알린다', () => {
    expect(notificationFor(s('error'), 'working', bg)).toMatchObject({ kind: 'error' })
  })

  it('응답 대기는 알리지 않는다 (뱃지로만 — 급하지 않다)', () => {
    expect(notificationFor(s('waiting_input'), 'working', bg)).toBeNull()
  })

  it('상태가 그대로면 알리지 않는다 (같은 이벤트 반복에도 한 번만)', () => {
    expect(notificationFor(s('waiting_approval'), 'waiting_approval', bg)).toBeNull()
  })

  it('앱이 눈앞에 있으면 알리지 않는다 (보고 있는데 알림은 소음)', () => {
    expect(notificationFor(s('waiting_approval'), 'working', { appFocused: true })).toBeNull()
  })

  it('정책으로 포그라운드 알림을 켤 수 있다', () => {
    const ctx = { appFocused: true, policy: { ...DEFAULT_NOTIFY_POLICY, whenFocused: true } }
    expect(notificationFor(s('waiting_approval'), 'working', ctx)).toMatchObject({ kind: 'approval' })
  })

  it('알림 본문에 세션 이름이 들어간다 (어느 세션인지 알아야 행동한다)', () => {
    expect(notificationFor(s('waiting_approval', 'auth 리팩터링'), 'working', bg)?.body).toContain('auth 리팩터링')
  })
})

describe('"전부 완료" 알림 (자리를 뜬 사람에게 필요한 신호)', () => {
  // 판정이 신원 기반이라 prev/now의 같은 세션은 같은 id를 가져야 한다
  const w = (id: string, state: SessionState, archived = false) => ({ id, state, archived })

  it('마지막 작업이 끝났을 때 한 번 알린다', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toMatchObject({ kind: 'all_done' })
  })

  it('아직 일하는 세션이 남았으면 알리지 않는다', () => {
    const prev = [w('a', 'working'), w('b', 'working')]
    const now = [w('a', 'working'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('이미 다 끝나 있었으면 다시 알리지 않는다 (중복 방지)', () => {
    const done = [w('a', 'waiting_input')]
    expect(allDoneNotification(done, done, bg)).toBeNull()
  })

  it('세션이 하나도 없으면 알리지 않는다', () => {
    expect(allDoneNotification([], [w('a', 'working')], bg)).toBeNull()
  })

  it('승인 대기 세션이 남았으면 "전부 완료"가 아니다 (막힌 에이전트는 손이 빈 게 아니다)', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_approval')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_approval')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('한도 대기 세션이 남았으면 알리지 않는다 (해제되면 스스로 재개한다)', () => {
    const prev = [w('a', 'working'), w('b', 'limited')]
    const now = [w('a', 'waiting_input'), w('b', 'limited')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('마지막 승인이 풀려 전부 응답 대기가 되면 그때 알린다', () => {
    const prev = [w('a', 'waiting_input'), w('b', 'waiting_approval')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toMatchObject({ kind: 'all_done' })
  })

  it('아카이브된 세션은 계산에서 빠진다', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input', true)]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_input', true)]
    expect(allDoneNotification(now, prev, bg)?.body).toContain('1 sessions')
  })

  /*
   * 개수 비교의 함정: 마지막 working 세션을 **치우면** busy가 0이 되지만
   * 일이 끝난 게 아니다 — 신원 비교라야 "바쁘던 그 세션이 실제로 손을 뗐다"를 안다.
   */
  it('마지막 working 세션을 아카이브해도 "All done"은 울리지 않는다', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('a', 'working', true), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('마지막 working 세션을 삭제해도 울리지 않는다', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('바쁘던 세션이 끝나는 사이 다른 세션이 새로 바빠졌으면 아직 끝이 아니다', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('a', 'waiting_input'), w('b', 'working')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })
})

describe('독 뱃지', () => {
  it('승인과 오류만 센다 (응답 대기는 뱃지를 태우지 않는다)', () => {
    expect(badgeCount({ approval: 2, error: 1 })).toBe(3)
    expect(badgeCount({ approval: 0, error: 0 })).toBe(0)
  })
})
