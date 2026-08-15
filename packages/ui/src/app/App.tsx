import { useEffect, useState } from 'react'
import { nextWaitingSession } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from './PlatformProvider.jsx'
import { useStore } from '../store/store.js'
import { useCounts, computeInbox } from '../store/selectors.js'
import { Sidebar } from '../features/sidebar/Sidebar.jsx'
import { SessionView } from '../features/session/SessionView.jsx'
import { Inbox } from '../features/inbox/Inbox.jsx'
import { ApprovalBanner } from '../features/approval/ApprovalBanner.jsx'
import { AddProjectDialog } from '../features/project/AddProjectDialog.jsx'
import { FirstRun } from '../features/onboarding/FirstRun.jsx'
import { Kbd } from '../components/primitives.jsx'

export function App({ platform }: { platform: Platform }) {
  const attach = useStore((s) => s.attach)
  const setAppFocused = useStore((s) => s.setAppFocused)

  useEffect(() => {
    void attach(platform)
  }, [platform, attach])

  // 알림 정책이 "눈앞에 있으면 알리지 않는다"이므로 포커스 상태를 추적한다
  useEffect(() => {
    const onFocus = () => setAppFocused(true)
    const onBlur = () => setAppFocused(false)
    const onVisibility = () => setAppFocused(document.visibilityState === 'visible')
    setAppFocused(document.hasFocus() && document.visibilityState === 'visible')
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [setAppFocused])

  return (
    <PlatformProvider platform={platform}>
      <div className="relative flex h-screen flex-col bg-void text-chalk">
        <TopBar />
        <ApprovalBanner />
        <Body />
        <Inbox />
        <Toast />
        <GlobalKeys />
      </div>
    </PlatformProvider>
  )
}

/** 프로젝트가 하나도 없으면 시작 안내가 화면을 대신한다 (FR-19) */
function Body() {
  const hasProjects = useStore((s) => Object.keys(s.projects).length > 0)
  if (!hasProjects) return <FirstRun />
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <SessionView />
    </div>
  )
}

/**
 * 상단 바 = 계기판. 승인과 응답대기는 절대 합산하지 않는다 (FR-12).
 * 기다리는 것이 없으면 숫자도 어두워진다 — 순백은 나를 기다리는 것의 몫이다.
 */
function TopBar() {
  const counts = useCounts()
  const toggleInbox = useStore((s) => s.toggleInbox)
  const connection = useStore((s) => s.connection)
  const [addOpen, setAddOpen] = useState(false)
  const waiting = counts.approval + counts.error + counts.input

  return (
    <header className="flex items-center gap-4 border-b border-edge bg-pit px-4 py-2">
      <span className="text-[12px] font-semibold tracking-[0.16em] text-chalk">CONTROL CENTER</span>

      <button
        className="group flex items-center gap-2.5 rounded px-2 py-1 transition-colors hover:bg-graphite/50"
        onClick={() => toggleInbox()}
        data-testid="counter"
        title="기다리는 항목 (⌘I)"
      >
        <Metric
          label="승인"
          value={counts.approval}
          tone={counts.approval > 0 ? 'beacon' : 'text-slate'}
          testId="count-approval"
        />
        <span className="text-edge">│</span>
        <Metric
          label="응답 대기"
          value={counts.input}
          tone={counts.input > 0 ? 'text-ash' : 'text-slate'}
          testId="count-input"
        />
        {counts.error > 0 && (
          <>
            <span className="text-edge">│</span>
            <Metric label="오류" value={counts.error} tone="beacon" testId="count-error" />
          </>
        )}
      </button>

      <span className="flex items-center gap-1 text-[10px] text-slate">
        <Kbd live={waiting > 0}>⌘</Kbd>
        <Kbd live={waiting > 0}>I</Kbd>
        <span className="mr-2">목록</span>
        <Kbd live={waiting > 0}>⌘</Kbd>
        <Kbd live={waiting > 0}>⇧</Kbd>
        <Kbd live={waiting > 0}>A</Kbd>
        다음 항목
      </span>

      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-slate" data-testid="connection">
          <span
            className={`size-1.5 rounded-full ${
              connection === 'connected' ? 'bg-ash' : 'bg-beacon breathe'
            }`}
            aria-hidden
          />
          {connection === 'connected' ? '연결됨' : connection === 'connecting' ? '연결 중' : '연결 끊김'}
        </span>
        <button
          className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk"
          onClick={() => setAddOpen(true)}
          data-testid="add-project"
        >
          프로젝트 추가
        </button>
      </span>

      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}
    </header>
  )
}

function Metric({
  label,
  value,
  tone,
  testId,
}: {
  label: string
  value: number
  tone: string
  testId: string
}) {
  return (
    <span className={`flex items-baseline gap-1.5 ${tone}`} data-testid={testId}>
      <span className="text-[10px] text-slate">{label}</span>
      <span className="readout text-[13px] leading-none">{String(value).padStart(2, '0')}</span>
    </span>
  )
}

/** 관제 루프는 마우스 없이 돌아야 한다 (FR-17) */
function GlobalKeys() {
  const toggleInbox = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        toggleInbox()
        return
      }
      // 다음 대기로 이동: 승인 → 오류 → 응답대기 순 (정렬은 core)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const st = useStore.getState()
        const next = nextWaitingSession(computeInbox(st), st.focusedSessionId)
        if (next) focusSession(next)
        return
      }
      // 숫자 단축키는 e.code로 본다 — Shift를 누르면 e.key가 '#' 같은 기호가 된다 (E2E가 잡음)
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
      // 탭 전환 ⌘⇧1~4 (FR-17)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && digit && Number(digit) <= 4) {
        e.preventDefault()
        const tabs = ['chat', 'files', 'git', 'viewer'] as const
        useStore.getState().setTab(tabs[Number(digit) - 1]!)
        return
      }
      // 프로젝트 점프 ⌘1~9 (FR-17)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && digit) {
        const st = useStore.getState()
        const project = Object.values(st.projects)[Number(digit) - 1]
        if (project) {
          e.preventDefault()
          const first = Object.values(st.sessions).find((s) => s.projectId === project.id && !s.archived)
          if (first) focusSession(first.id)
        }
        return
      }
      if (!typing && e.key === 'Escape') toggleInbox(false)
    }
    // 전역 단축키(앱 밖에서 누른 ⌘⇧A)도 같은 동작으로 들어온다
    const onExternalNext = () => {
      const st = useStore.getState()
      const next = nextWaitingSession(computeInbox(st), st.focusedSessionId)
      if (next) focusSession(next)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('cc:next-waiting', onExternalNext)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('cc:next-waiting', onExternalNext)
    }
  }, [toggleInbox, focusSession])

  return null
}

function Toast() {
  const toast = useStore((s) => s.toast)
  const setToast = useStore((s) => s.setToast)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast, setToast])
  if (!toast) return null
  return (
    <div
      className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded border border-edge bg-panel px-3 py-2 text-[12px] text-chalk shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      data-testid="toast"
      role="status"
    >
      {toast}
    </div>
  )
}
