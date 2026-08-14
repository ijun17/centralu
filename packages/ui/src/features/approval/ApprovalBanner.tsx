import { bannerDecision } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useBannerApproval } from '../../store/selectors.js'
import { detailText } from './ApprovalCard.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 비포커스 세션의 승인 요청 (FR-3).
 * 배너에서 바로 승인할 수 있다 — 판단에 컨텍스트가 필요한 요청만 "확인 필요"로 점프를 유도한다.
 * 강제가 아니라 정보 부족의 표시.
 */
export function ApprovalBanner() {
  const banner = useBannerApproval()
  const respond = useStore((s) => s.respondApproval)
  const focusSession = useStore((s) => s.focusSession)

  if (!banner) return null
  const { session, pending } = banner
  const decision = bannerDecision(pending.detail)

  return (
    <div
      className="flex items-center gap-3 border-b border-rose-700/60 bg-rose-950/40 px-4 py-2 text-xs"
      data-testid="approval-banner"
    >
      <span className="shrink-0 font-semibold text-rose-300">승인 대기</span>
      <span className="shrink-0 text-neutral-400">{session.name}</span>
      <code className="min-w-0 flex-1 truncate text-neutral-200" data-testid="banner-summary">
        {detailText(pending.detail).split('\n')[0]}
      </code>

      {decision.mode === 'inline' ? (
        <span className="flex shrink-0 gap-2">
          <button
            className="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
            onClick={() => void respond(session.id, pending.requestId, 'allow')}
            data-testid="banner-allow"
          >
            <Kbd>y</Kbd> 허용
          </button>
          <button
            className="rounded bg-neutral-700 px-2 py-0.5 text-white hover:bg-neutral-600"
            onClick={() => void respond(session.id, pending.requestId, 'deny')}
            data-testid="banner-deny"
          >
            거부
          </button>
        </span>
      ) : (
        <button
          className="shrink-0 rounded bg-neutral-700 px-2 py-0.5 text-white hover:bg-neutral-600"
          onClick={() => focusSession(session.id)}
          data-testid="banner-review"
          title={reasonText(decision.reason)}
        >
          확인 필요 →
        </button>
      )}
    </div>
  )
}

function reasonText(reason: string): string {
  return reason === 'diff_required'
    ? '변경 내용을 봐야 판단할 수 있습니다'
    : reason === 'too_long'
      ? '명령이 길어 배너에서 잘립니다'
      : reason === 'multi_file'
        ? '여러 파일을 수정합니다'
        : '내용을 확인해야 합니다'
}
