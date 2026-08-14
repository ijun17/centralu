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
import { Kbd } from '../components/primitives.jsx'

export function App({ platform }: { platform: Platform }) {
  const attach = useStore((s) => s.attach)
  useEffect(() => {
    void attach(platform)
  }, [platform, attach])

  return (
    <PlatformProvider platform={platform}>
      <div className="relative flex h-screen flex-col bg-neutral-950 text-neutral-100">
        <TopBar />
        <ApprovalBanner />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <SessionView />
        </div>
        <Inbox />
        <Toast />
        <GlobalKeys />
      </div>
    </PlatformProvider>
  )
}

/** 전역 카운터는 절대 합산하지 않는다 (FR-12) */
function TopBar() {
  const counts = useCounts()
  const toggleInbox = useStore((s) => s.toggleInbox)
  const connection = useStore((s) => s.connection)
  const [addOpen, setAddOpen] = useState(false)

  return (
    <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
      <span className="font-semibold">Control Center</span>
      <button
        className="flex items-center gap-2 rounded bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-800"
        onClick={() => toggleInbox()}
        data-testid="counter"
        title="인박스 (⌘I)"
      >
        <span className="text-rose-400" data-testid="count-approval">
          승인 {counts.approval}
        </span>
        <span className="text-neutral-600">·</span>
        <span className="text-sky-400" data-testid="count-input">
          응답대기 {counts.input}
        </span>
        {counts.error > 0 && (
          <>
            <span className="text-neutral-600">·</span>
            <span className="text-rose-500" data-testid="count-error">
              오류 {counts.error}
            </span>
          </>
        )}
      </button>
      <span className="text-[10px] text-neutral-600">
        <Kbd>⌘I</Kbd> 인박스 <Kbd>⌘⇧A</Kbd> 다음 대기
      </span>
      <span className="ml-auto flex items-center gap-2 text-xs">
        <span
          className={connection === 'connected' ? 'text-emerald-500' : 'text-amber-500'}
          data-testid="connection"
        >
          {connection === 'connected' ? '연결됨' : connection === 'connecting' ? '연결 중…' : '연결 끊김'}
        </span>
        <button
          className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
          onClick={() => setAddOpen(true)}
          data-testid="add-project"
        >
          ＋ 프로젝트
        </button>
      </span>
      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}
    </header>
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
      if (!typing && e.key === 'Escape') toggleInbox(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-neutral-800 px-3 py-2 text-xs text-neutral-100 shadow-lg"
      data-testid="toast"
    >
      {toast}
    </div>
  )
}
