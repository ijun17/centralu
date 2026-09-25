import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { SessionPane } from '../session/SessionView.jsx'
import { useStore } from '../../store/store.js'

/**
 * 만드는 세션의 대화를 앱 화면 **옆에** 연다 (M4 C-5).
 *
 * 링크로 그 세션에 데려가는 길도 있었다. 그러면 가운데 레인이 세션으로 바뀌고 앱 화면은 숨는다 — "사람은 앱을 떠나지
 * 않는다"(플랜 C-5)는 약속이 누르는 순간 깨진다. 옆에 여는 쪽은 만드는 에이전트가 고치는 동안 화면이 바뀌는 것을
 * 같은 눈에 담게 하고, 에이전트가 되묻는 말에 그 자리에서 답하게 한다. 새로 짜는 것이 거의 없다는 것도 이유다: 대화
 * 한 칸은 그리드가 이미 쓰는 SessionPane 그대로다(모델·권한·입력창·승인 카드까지). 입력창은 접어 둔다 — 좁은 옆 칸에서
 * 읽는 자리를 먹지 않게(그리드와 같은 접힘). 말은 대개 아래 입력줄로 한다.
 */
export function BuilderPane({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const known = useStore((s) => !!s.sessions[sessionId])
  return (
    <aside className="flex w-[380px] min-w-0 shrink-0 flex-col border-l border-edge" data-testid="builder-pane" aria-label="Builder conversation">
      {known ? (
        <SessionPane
          sessionId={sessionId}
          fold
          headerExtra={
            <IconButton label="Close the builder conversation" onClick={onClose} testId="builder-pane-close" align="right">
              <CloseIcon />
            </IconButton>
          }
        />
      ) : (
        <p className="px-3 py-3 text-[12px] text-slate">The builder session is not loaded yet.</p>
      )}
    </aside>
  )
}
