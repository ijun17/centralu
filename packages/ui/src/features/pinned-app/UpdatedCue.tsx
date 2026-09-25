import { useEffect, useState } from 'react'

/** 서 있는 시간 — 눈이 한 번 스치면 충분하다 */
const SHOWN_MS = 8_000
/** 다시 연 지 이만큼 지났으면 서지 않는다 — 다른 데 갔다 돌아와 다시 그려진 화면에 옛 소식을 붙이지 않게 */
const FRESH_MS = 30_000

/**
 * "Updated" — 앱이 새 코드로 다시 떠서 화면을 다시 열었다는 한 마디 (M4 C-4).
 *
 * 만드는 에이전트가 고친 결과가 사람 앞에서 **소리 없이** 바뀌면, 사람은 화면이 바뀐 것인지 제가 잘못 본 것인지 모른다.
 * 그렇다고 사람을 부를 일은 아니다 — 기다림이나 소식은 조용한 색의 몫이다(팔레트 규칙). 그래서 제목 옆에 작은 글자
 * 하나가 잠깐 섰다가 걷힌다. 서는 시간은 이것이 그려진 때부터 잰다(`at`에서 재면, 새 화면이 뜨는 데 걸린 시간만큼
 * 깎인다). 다시 연 지 오래됐으면 다시 그려져도 서지 않는다.
 */
export function UpdatedCue({ at, testId }: { at: number; testId: string }) {
  const [shown, setShown] = useState(() => Date.now() - at < FRESH_MS)
  useEffect(() => {
    const t = setTimeout(() => setShown(false), SHOWN_MS)
    return () => clearTimeout(t)
  }, [at])
  if (!shown) return null
  return (
    <span className="readout shrink-0 text-[10px] text-slate" data-testid={testId} title="The app now runs new code, so this view was opened again">
      Updated
    </span>
  )
}
