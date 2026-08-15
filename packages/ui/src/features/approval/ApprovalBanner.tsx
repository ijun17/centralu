import { bannerDecision } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useBannerApproval } from '../../store/selectors.js'
import { detailText } from './ApprovalCard.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 비포커스 세션의 승인 요청 (FR-3).
 * 배너에서 바로 승인할 수 있다 — 판단에 컨텍스트가 필요한 요청만 세션으로 보낸다.
 * 강제가 아니라 정보가 부족하다는 표시.
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
      className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-1.5"
      data-testid="approval-banner"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-signal-act" aria-hidden />
      <span className="shrink-0 text-[12px] text-ash">{session.name}</span>
      <code
        className="min-w-0 flex-1 truncate font-mono text-[12px] text-chalk"
        data-testid="banner-summary"
      >
        {detailText(pending.detail).split('\n')[0]}
      </code>

      {decision.mode === 'inline' ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-ash hover:bg-graphite hover:text-chalk"
            onClick={() => void respond(session.id, pending.requestId, 'allow')}
            data-testid="banner-allow"
          >
            <Kbd live>y</Kbd> 허용
          </button>
          <button
            className="rounded px-1.5 py-1 text-[12px] text-slate hover:bg-graphite hover:text-chalk"
            onClick={() => void respond(session.id, pending.requestId, 'deny')}
            data-testid="banner-deny"
          >
            거부
          </button>
        </span>
      ) : (
        <button
          className="shrink-0 rounded px-2 py-1 text-[12px] text-signal-act hover:bg-graphite"
          onClick={() => focusSession(session.id)}
          data-testid="banner-review"
          title={reasonText(decision.reason)}
        >
          내용 확인 →
        </button>
      )}
    </div>
  )
}

function reasonText(reason: string): string {
  return reason === 'diff_required'
    ? '변경 내용을 봐야 판단할 수 있습니다'
    : reason === 'too_long'
      ? '명령이 길어 여기서는 잘립니다'
      : reason === 'multi_file'
        ? '여러 파일을 한 번에 수정합니다'
        : '내용을 확인해야 합니다'
}
