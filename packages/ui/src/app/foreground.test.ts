import { describe, expect, it } from 'vitest'
import { isForeground } from './foreground.js'

describe('앱이 눈앞에 있는가', () => {
  it('포커스가 있고 보이면 눈앞이다', () => {
    expect(isForeground(true, 'visible')).toBe(true)
  })

  it('최소화하면 눈앞이 아니다', () => {
    expect(isForeground(true, 'hidden')).toBe(false)
  })

  /*
   * 알림이 조용히 막히던 자리.
   *
   * 다른 앱으로 가면 창은 여전히 'visible'이지만 포커스는 없다.
   * visibility만 보면 여기서 '눈앞'이라고 답하고, 그때부터 알림이 나가지 않는다 —
   * 사람은 자리를 비웠는데 앱은 눈앞에 있다고 믿는 상태다.
   */
  it('다른 앱에 가려지면 창이 보여도 눈앞이 아니다', () => {
    expect(isForeground(false, 'visible')).toBe(false)
  })

  it('둘 다 아니면 당연히 아니다', () => {
    expect(isForeground(false, 'hidden')).toBe(false)
  })
})
