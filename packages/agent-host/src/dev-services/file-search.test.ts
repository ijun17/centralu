import { describe, expect, it } from 'vitest'
import { score } from './file-search.js'

/**
 * `@ses`라고 칠 때 사람이 찾는 건 대개 `SessionView.tsx`다.
 * 경로 여기저기 흩어진 글자보다 **파일 이름에서의 매치**가 위에 와야 한다.
 */
describe('파일 퍼지 점수', () => {
  const rank = (paths: string[], q: string) =>
    paths
      .map((p) => ({ p, s: score(p, q) }))
      .filter((x): x is { p: string; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p)

  it('파일 이름 매치가 경로 매치보다 위다', () => {
    const out = rank(
      ['packages/session/core/util.ts', 'packages/ui/src/features/session/SessionView.tsx'],
      'session',
    )
    expect(out[0]).toBe('packages/ui/src/features/session/SessionView.tsx')
  })

  it('이름 앞에서 시작하는 쪽이 위다', () => {
    const out = rank(['src/UserSession.ts', 'src/SessionView.tsx'], 'session')
    expect(out[0]).toBe('src/SessionView.tsx')
  })

  it('얕은 경로가 살짝 위다 (같은 조건이면)', () => {
    const out = rank(['a/b/c/d/e/App.tsx', 'src/App.tsx'], 'app.tsx')
    expect(out[0]).toBe('src/App.tsx')
  })

  it('흩어진 글자도 받아준다 (부분 수열)', () => {
    expect(score('src/SessionView.tsx', 'ssnvw')).not.toBeNull()
    expect(score('src/SessionView.tsx', 'zzz')).toBeNull()
  })

  it('빈 질의는 전부 통과시킨다', () => {
    expect(score('anything.ts', '')).toBe(0)
  })
})
