import { useEffect } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { suggestMatcher } from '@cc/core'
import { useStore } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 승인 카드 (FR-3). 키보드 우선 — y/n/a, ⌥a는 프로젝트 범위.
 * 마우스보다 느린 GUI는 터미널보다 나쁘다.
 * 색은 왼쪽 레일 하나로만 쓴다: 카드를 통째로 물들이면 명령문 자체가 안 읽힌다.
 */
export function ApprovalCard({
  sessionId,
  requestId,
  detail,
}: {
  sessionId: string
  requestId: string
  detail: ApprovalDetail
}) {
  const respond = useStore((s) => s.respondApproval)
  const setToast = useStore((s) => s.setToast)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      const k = e.key.toLowerCase()
      if (k === 'y') void respond(sessionId, requestId, 'allow')
      else if (k === 'n') void respond(sessionId, requestId, 'deny')
      else if (k === 'a') {
        const scope = e.altKey ? 'project' : 'session'
        void respond(sessionId, requestId, 'always', scope)
        setToast(`${scope === 'project' ? '이 프로젝트' : '이 세션'}에서 항상 허용: ${matcherOf(detail)}`)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, respond, setToast])

  return (
    <div
      className="overflow-hidden rounded border border-edge border-l-2 border-l-signal-act bg-panel"
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-signal-act">
          승인 대기
        </span>
        <span className="text-[11px] text-slate">에이전트가 멈춰 기다립니다</span>
      </div>

      <pre
        className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap px-3 font-mono text-[12px] leading-relaxed text-chalk"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <div className="mt-3 flex items-center gap-1.5 border-t border-edge bg-void/40 px-3 py-2">
        <ActionKey k="y" label="허용" onClick={() => void respond(sessionId, requestId, 'allow')} testId="approve-allow" />
        <ActionKey k="n" label="거부" onClick={() => void respond(sessionId, requestId, 'deny')} testId="approve-deny" />
        <ActionKey
          k="a"
          label="항상 허용"
          testId="approve-always"
          title="⌥를 누른 채 클릭하면 프로젝트 전체에 적용됩니다"
          onClick={(alt) => {
            const scope = alt ? 'project' : 'session'
            void respond(sessionId, requestId, 'always', scope)
            setToast(`${scope === 'project' ? '이 프로젝트' : '이 세션'}에서 항상 허용: ${matcherOf(detail)}`)
          }}
        />
        <span className="ml-auto text-[10px] text-slate">
          <Kbd>⌥</Kbd> <Kbd>a</Kbd> 프로젝트 전체
        </span>
      </div>
    </div>
  )
}

function ActionKey({
  k,
  label,
  onClick,
  testId,
  title,
}: {
  k: string
  label: string
  onClick: (alt: boolean) => void
  testId: string
  title?: string
}) {
  return (
    <button
      className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-ash transition-colors hover:bg-graphite hover:text-chalk"
      onClick={(e) => onClick(e.altKey)}
      data-testid={testId}
      title={title}
    >
      <Kbd live>{k}</Kbd>
      {label}
    </button>
  )
}

export function detailText(d: ApprovalDetail): string {
  if (d.kind === 'command') return `${d.command}\n${d.cwd}`
  if (d.kind === 'file_edit') return `${d.path}\n\n${d.diffPreview}`
  return d.raw
}

export function matcherOf(d: ApprovalDetail): string {
  return d.kind === 'command' ? suggestMatcher(d.command) : d.kind === 'file_edit' ? d.path : '기타'
}
