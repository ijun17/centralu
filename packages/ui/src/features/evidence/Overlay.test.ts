import { describe, expect, it } from 'vitest'
import { overlayTakesEscape } from './Overlay.jsx'

/*
 * #181: 오버레이는 창의 캡처 단계에서 Esc를 받는다 — 모든 요소보다 먼저다. 대상을 보지 않던 동안 옆 증거 패널의
 * 터미널(vim·less)에 Esc가 가지 않았고, 위에 뜬 설정 창·모달 대신 가려진 오버레이가 먼저 닫혔다.
 */
describe('overlayTakesEscape — 오버레이의 Esc는 맨 위이고 제 쪽에서 왔을 때만 (#181)', () => {
  const none = { openLayers: 0, settingsOpen: false, paletteOpen: false, inboxOpen: false, usageOpen: false }
  const at = (inPanel: boolean) => ({ closest: (sel: string) => (inPanel && sel.includes('evidence-panel') ? {} : null) }) as unknown as EventTarget

  it('입력창(가려진 대화)이나 빈 곳에서 누르면 걷는다 — 덮인 채 갇히면 안 된다', () => {
    expect(overlayTakesEscape(none, at(false))).toBe(true)
    expect(overlayTakesEscape(none, null)).toBe(true)
  })

  it('옆 증거 패널(터미널)에서 누른 Esc는 그 패널의 것이다', () => {
    expect(overlayTakesEscape(none, at(true))).toBe(false)
  })

  it('위에 다른 층이 떠 있으면 그 층이 받는다', () => {
    expect(overlayTakesEscape({ ...none, openLayers: 1 }, at(false))).toBe(false)
    expect(overlayTakesEscape({ ...none, settingsOpen: true }, at(false))).toBe(false)
    expect(overlayTakesEscape({ ...none, paletteOpen: true }, at(false))).toBe(false)
  })
})
