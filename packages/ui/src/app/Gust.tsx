import { useEffect, useState } from 'react'
import { useStore } from '../store/store.js'
import { isOnScreen } from './onscreen.js'

/** 바람이 지나가는 시간 (CSS의 cc-gust와 같아야 한다 — 끝나면 DOM에서 걷는다) */
const GUST_MS = 1100

/**
 * 응답이 끝났다는 것을 **몸으로** 알려주는 한 번의 바람.
 *
 * 글자로 "끝났습니다"라고 적는 대신 화면이 한 번 숨을 쉰다. 읽지 않아도 알 수 있고,
 * 지나가면 아무것도 남기지 않으므로 화면을 어지럽히지 않는다.
 *
 * 지나간 뒤에는 DOM에서 걷는다. 투명한 채로 남겨두면 화면 전체를 덮는 요소가
 * 항상 하나 떠 있게 된다 — 지금은 pointer-events가 없어 괜찮지만, 그런 것이
 * 남아 있으면 언젠가 무언가를 가린다.
 */
export function Gust() {
  const completion = useStore((s) => s.completion)
  const view = useStore((s) => s.view)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const orchestratorId = useStore((s) => s.orchestratorId)
  const gridPanels = useStore((s) => s.gridPanels)
  const [blowing, setBlowing] = useState<number | null>(null)

  const at = completion?.at ?? null
  const shows =
    completion !== null &&
    isOnScreen(view, completion.sessionId, { focusedSessionId, orchestratorId, gridPanels })

  useEffect(() => {
    if (!shows || at === null) return
    setBlowing(at)
    const t = setTimeout(() => setBlowing(null), GUST_MS)
    return () => clearTimeout(t)
  }, [at, shows])

  if (blowing === null) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      data-testid="gust"
      aria-hidden
    >
      {/* key: 같은 세션이 연달아 끝나도 애니메이션이 처음부터 다시 돈다 */}
      <div key={blowing} className="cc-gust" />
    </div>
  )
}
