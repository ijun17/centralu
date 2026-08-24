import { useEffect } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { suggestMatcher } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { letterOf } from '../../app/keys.js'
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
  const sc = useShortcut()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable,
        // 카드가 다른 화면 뒤에 있거나 **포커스된 세션의 카드가 아니면** 받지 않는다 —
        // 그리드에서 카드가 여럿 떠 있을 때 y 하나가 전부를 승인하면 안 된다
        covered: approvalCardCovered(st, sessionId),
      })
      if (!action) return
      void respond(sessionId, requestId, action.decision, action.scope)
      if (action.decision === 'always') {
        setToast(`Always allow in ${action.scope === 'project' ? 'this project' : 'this session'}: ${matcherOf(detail)}`)
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, respond, setToast])

  return (
    <div
      className="overflow-hidden rounded border border-edge border-l-2 border-l-beacon bg-panel"
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="beacon text-[10px] font-medium tracking-[0.1em]">
          Awaiting approval
        </span>
        <span className="text-[11px] text-slate">Agent is blocked, waiting</span>
      </div>

      <pre
        className="mt-2 whitespace-pre-wrap break-words px-3 font-mono text-[12px] leading-relaxed text-chalk"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <div className="mt-3 flex items-center gap-1.5 border-t border-edge bg-void/40 px-3 py-2">
        <ActionKey k="y" label="Allow" onClick={() => void respond(sessionId, requestId, 'allow')} testId="approve-allow" />
        <ActionKey k="n" label="Deny" onClick={() => void respond(sessionId, requestId, 'deny')} testId="approve-deny" />
        <ActionKey
          k="a"
          label="Always allow"
          testId="approve-always"
          title={`Hold ${sc('alt')} and click to apply to the whole project`}
          onClick={(alt) => {
            const scope = alt ? 'project' : 'session'
            void respond(sessionId, requestId, 'always', scope)
            setToast(`Always allow in ${scope === 'project' ? 'this project' : 'this session'}: ${matcherOf(detail)}`)
          }}
        />
        <span className="ml-auto text-[10px] text-slate">
          <Kbd alt /> <Kbd>a</Kbd> whole project
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

export type ApprovalKeyAction = { decision: 'allow' | 'deny' | 'always'; scope?: 'session' | 'project' }

/**
 * 이 카드가 지금 키 입력을 받아도 되는가 (순수 함수 — 테스트가 여기 붙는다).
 *
 * 모달·오버레이에 가린 경우 외에 **포커스되지 않은 세션의 카드**도 받으면 안 된다:
 * 그리드에서는 pane마다 카드가 각자 window 리스너를 달아, 승인이 2개 이상 떠 있을 때
 * y 한 번이 **전부를 한꺼번에 승인**했다 — 이 앱에서 가장 잘못 눌리면 안 되는 버튼이다.
 * 키보드 승인은 언제나 "지금 포커스한 그 세션" 하나에만 간다.
 */
export function approvalCardCovered(
  st: {
    inboxOpen: boolean
    usageOpen: boolean
    settingsOpen: boolean
    paletteOpen: boolean
    overlay: unknown
    focusedSessionId: string | null
  },
  sessionId: string,
): boolean {
  return (
    st.inboxOpen ||
    st.usageOpen ||
    st.settingsOpen ||
    st.paletteOpen ||
    st.overlay !== null ||
    st.focusedSessionId !== sessionId
  )
}

/**
 * 전역 y/n/a 키가 **언제** 승인이 되는지의 전부 (순수 함수 — 테스트가 여기 붙는다).
 *
 * ⌘·⌃·⇧ 조합은 다른 단축키다: ⌘A(전체 선택)와, 이 앱이 상단 바에 광고하는
 * ⌘⇧A(다음 대기)가 그대로 흘러들어 '항상 허용'을 눌렀다 — 승인은 이 앱에서
 * 가장 잘못 눌리면 안 되는 버튼이다. ⌥만 통과시킨다 (⌥a = 프로젝트 범위 약속).
 * 입력창에 타이핑 중이거나 카드가 모달·오버레이 뒤에 가려져 있어도 받지 않는다.
 */
export function approvalKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  ctx: { typing: boolean; covered: boolean },
): ApprovalKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null
  if (ctx.typing || ctx.covered) return null
  // 글자는 자판이 아니라 **뜻**으로 읽는다 — ⌥가 붙거나 한글 자판이면 `key`는 다른 글자다 (app/keys.ts)
  const k = letterOf(e)
  if (k === 'y') return { decision: 'allow' }
  if (k === 'n') return { decision: 'deny' }
  if (k === 'a') return { decision: 'always', scope: e.altKey ? 'project' : 'session' }
  return null
}

export function detailText(d: ApprovalDetail): string {
  if (d.kind === 'command') return `${d.command}\n${d.cwd}`
  if (d.kind === 'file_edit') return `${d.path}\n\n${d.diffPreview}`
  return d.raw
}

export function matcherOf(d: ApprovalDetail): string {
  return d.kind === 'command' ? suggestMatcher(d.command) : d.kind === 'file_edit' ? d.path : 'other'
}
