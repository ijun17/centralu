import { useEffect } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { suggestMatcher } from '@cc/core'
import { useStore } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 승인 카드 (FR-3). 키보드 우선 — y/n/a, ⌥a는 프로젝트 범위.
 * 마우스보다 느린 GUI는 터미널보다 나쁘다.
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
        setToast(`항상 허용 (${scope === 'project' ? '프로젝트' : '세션'} 범위): ${matcherOf(detail)}`)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, respond, setToast])

  return (
    <div className="rounded-lg border border-rose-700/60 bg-rose-950/30 p-3" data-testid="approval-card">
      <div className="mb-1 text-xs font-semibold text-rose-300">승인 요청</div>
      <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-neutral-200" data-testid="approval-detail">
        {detailText(detail)}
      </pre>
      <div className="flex items-center gap-2 text-xs">
        <button
          className="rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600"
          onClick={() => void respond(sessionId, requestId, 'allow')}
          data-testid="approve-allow"
        >
          <Kbd>y</Kbd> 허용
        </button>
        <button
          className="rounded bg-neutral-700 px-2 py-1 text-white hover:bg-neutral-600"
          onClick={() => void respond(sessionId, requestId, 'deny')}
          data-testid="approve-deny"
        >
          <Kbd>n</Kbd> 거부
        </button>
        <button
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 hover:bg-neutral-700"
          onClick={() => {
            void respond(sessionId, requestId, 'always', 'session')
            setToast(`항상 허용 (세션 범위): ${matcherOf(detail)}`)
          }}
          data-testid="approve-always"
          title="⌥ 누르고 클릭하면 프로젝트 범위"
        >
          <Kbd>a</Kbd> 항상 허용
        </button>
        <span className="ml-auto text-[10px] text-neutral-500">⌥a: 프로젝트 범위</span>
      </div>
    </div>
  )
}

export function detailText(d: ApprovalDetail): string {
  if (d.kind === 'command') return `$ ${d.command}\n(${d.cwd})`
  if (d.kind === 'file_edit') return `${d.path}\n\n${d.diffPreview}`
  return d.raw
}

export function matcherOf(d: ApprovalDetail): string {
  return d.kind === 'command' ? suggestMatcher(d.command) : d.kind === 'file_edit' ? d.path : '기타'
}
