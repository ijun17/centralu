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
  const w = (state: SessionState, archived = false) => ({ state, archived })

  it('마지막 작업이 끝났을 때 한 번 알린다', () => {
    const prev = [w('working'), w('waiting_input')]
    const now = [w('waiting_input'), w('waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toMatchObject({ kind: 'all_done' })
  })

  it('아직 일하는 세션이 남았으면 알리지 않는다', () => {
    const prev = [w('working'), w('working')]
    const now = [w('working'), w('waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('이미 다 끝나 있었으면 다시 알리지 않는다 (중복 방지)', () => {
    const done = [w('waiting_input')]
    expect(allDoneNotification(done, done, bg)).toBeNull()
  })

  it('세션이 하나도 없으면 알리지 않는다', () => {
    expect(allDoneNotification([], [w('working')], bg)).toBeNull()
  })

  it('아카이브된 세션은 계산에서 빠진다', () => {
    const prev = [w('working'), w('waiting_input', true)]
    const now = [w('waiting_input'), w('waiting_input', true)]
    expect(allDoneNotification(now, prev, bg)?.body).toContain('1개')
  })
})

describe('독 뱃지', () => {
  it('승인과 오류만 센다 (응답 대기는 뱃지를 태우지 않는다)', () => {
    expect(badgeCount({ approval: 2, error: 1 })).toBe(3)
    expect(badgeCount({ approval: 0, error: 0 })).toBe(0)
  })
})
