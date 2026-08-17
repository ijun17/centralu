import { describe, expect, it } from 'vitest'
import { formatElapsed } from './SessionView.jsx'

/**
 * 경과 시간은 "멈춘 건가?"에 답하는 숫자다.
 * 3초와 3분이 같아 보이면 표시하는 의미가 없다.
 */
describe('formatElapsed', () => {
  it('1분 미만은 초로', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59)).toBe('59s')
  })
  it('1분부터는 분과 초로 — 초를 버리면 숫자가 멈춰 보인다', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(125)).toBe('2m 5s')
  })
  it('1시간부터는 시간과 분으로', () => {
    expect(formatElapsed(3600)).toBe('1h 0m')
    expect(formatElapsed(7860)).toBe('2h 11m')
  })
})
