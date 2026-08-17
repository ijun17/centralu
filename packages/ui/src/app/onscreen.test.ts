import { describe, expect, it } from 'vitest'
import { isOnScreen } from './onscreen.js'

const ctx = { focusedSessionId: 'a', orchestratorId: 'orc', gridPanels: ['b', 'c'] }

describe('바람은 화면에 있는 세션이 끝났을 때만 분다', () => {
  it('포커스 뷰 — 보고 있는 그 세션', () => {
    expect(isOnScreen('focus', 'a', ctx)).toBe(true)
    expect(isOnScreen('focus', 'b', ctx)).toBe(false)
  })

  it('오케스트레이터 화면 — 그 세션', () => {
    expect(isOnScreen('orchestrator', 'orc', ctx)).toBe(true)
    expect(isOnScreen('orchestrator', 'a', ctx)).toBe(false)
  })

  it('컨트롤 센터 — 올라와 있는 칸 중 하나', () => {
    expect(isOnScreen('grid', 'c', ctx)).toBe(true)
    expect(isOnScreen('grid', 'a', ctx)).toBe(false)
  })

  /*
   * 이게 요점이다. 세션이 열 개면 화면 밖 완료도 열 번이고,
   * 그때마다 화면을 쓸면 읽고 있던 것을 방해한다 — 그건 알림의 몫이다.
   */
  it('화면 밖에서 끝난 것은 불지 않는다', () => {
    expect(isOnScreen('focus', 'zzz', ctx)).toBe(false)
    expect(isOnScreen('grid', 'zzz', ctx)).toBe(false)
    expect(isOnScreen('orchestrator', 'zzz', ctx)).toBe(false)
  })
})
