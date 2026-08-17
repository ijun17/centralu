import { describe, expect, it } from 'vitest'
import { decideFollow, distanceFromBottom, isAtBottom, shouldFollowAgain } from './scroll.js'

describe('바닥에 있는가', () => {
  it('딱 바닥', () => {
    expect(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('조금 위는 아직 바닥으로 본다 — 픽셀로 딱 맞을 일은 없다', () => {
    expect(isAtBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('멀리 올라가면 아니다', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('내용이 화면보다 작으면 거리는 0 이하다', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0)
  })
})

describe('따라갈 것인가', () => {
  it('바닥에 붙어 있고 위치가 그대로면 따라간다', () => {
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900 })).toBe('follow')
  })

  it('이미 놓았으면 아무것도 안 한다', () => {
    expect(decideFollow({ sticking: false, scrollTop: 0, lastTop: 900 })).toBe('ignore')
  })

  /*
   * 이 프로젝트에서 실제로 났던 경합이다.
   *
   * 사람이 위로 올렸는데 스크롤 이벤트가 아직 처리되지 않아 플래그는 true인 상태에서,
   * 가상 스크롤이 줄을 재며 총 높이가 바뀌어 "따라가기"가 먼저 돌았다.
   * 플래그만 봤다면 여기서 사람을 도로 바닥으로 끌어내린다.
   *
   * e2e로는 이 순간을 붙잡지 못했다 — 기다림을 넣으면 고치기 전 코드에서도 같이 깨졌다.
   * 판단을 떼어내니 값 세 개로 표현된다.
   */
  it('플래그는 아직 true인데 이미 위로 올라가 있으면 놓는다', () => {
    expect(decideFollow({ sticking: true, scrollTop: 0, lastTop: 12084 })).toBe('release')
  })

  it('내용이 늘어난 것과 사람이 올린 것을 구분한다', () => {
    // 내용이 늘어도 scrollTop은 그대로다 → 따라간다
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900 })).toBe('follow')
    // 사람이 올리면 scrollTop이 줄어든다 → 놓는다
    expect(decideFollow({ sticking: true, scrollTop: 700, lastTop: 900 })).toBe('release')
  })

  it('1~2px 흔들림은 사람이 올린 것으로 치지 않는다 — 브라우저 반올림이다', () => {
    expect(decideFollow({ sticking: true, scrollTop: 898, lastTop: 900 })).toBe('follow')
  })
})

describe('미뤄둔 프레임에서 한 번 더', () => {
  it('여전히 바닥 근처면 한 번 더 내린다 (새 줄은 다음 프레임에 측정된다)', () => {
    expect(shouldFollowAgain({ scrollTop: 900, scrollHeight: 1040, clientHeight: 100 })).toBe(true)
  })

  it('그 사이 사람이 올렸으면 내리지 않는다 — 예약할 때의 판단을 그대로 쓰면 사람을 이긴다', () => {
    expect(shouldFollowAgain({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })
})
