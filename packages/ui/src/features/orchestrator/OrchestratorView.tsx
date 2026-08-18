import { useStore } from '../../store/store.js'
import { SessionPane } from '../session/SessionView.jsx'

/**
 * 오케스트레이터 화면 — **말로 관제**.
 *
 * 세션 하나이므로 SessionPane을 그대로 쓴다. 그리드의 칸도, 포커스 뷰도
 * 같은 부품이다 — 복사본을 두면 한쪽에서 모델을 바꿨을 때 다른 쪽이 옛 값을 든다.
 *
 * 우측 증거 패널은 없다. 이 세션에는 프로젝트가 없어서 볼 깃도 파일도 없다 —
 * 빈 패널을 띄우면 "여기서 뭘 봐야 하나"를 매번 묻게 된다.
 */
export function OrchestratorView() {
  const id = useStore((s) => s.orchestratorId)

  // 세션을 만드는 동안. 화면부터 바뀌므로 이 순간이 실제로 존재한다
  if (!id) {
    return (
      <div className="flex flex-1 items-center justify-center" data-testid="orchestrator-loading">
        <p className="text-[13px] text-slate">Waking the orchestrator…</p>
      </div>
    )
  }
  return <SessionPane sessionId={id} />
}
