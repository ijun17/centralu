import { useEffect, useState } from 'react'
import { nextWaitingSession } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from './PlatformProvider.jsx'
import { isForeground } from './foreground.js'
import { useStore } from '../store/store.js'
import { useCounts, computeInbox } from '../store/selectors.js'
import { Sidebar } from '../features/sidebar/Sidebar.jsx'
import { EvidencePanel } from '../features/evidence/EvidencePanel.jsx'
import { Overlay } from '../features/evidence/Overlay.jsx'
import { SessionView } from '../features/session/SessionView.jsx'
import { ControlCenter } from '../features/control-center/ControlCenter.jsx'
import { Inbox } from '../features/inbox/Inbox.jsx'
import { ApprovalBanner } from '../features/approval/ApprovalBanner.jsx'
import { AddProjectDialog } from '../features/project/AddProjectDialog.jsx'
import { FirstRun } from '../features/onboarding/FirstRun.jsx'
import { CommandPalette } from '../features/palette/CommandPalette.jsx'
import { Settings } from '../features/settings/Settings.jsx'
import { UsageModal } from '../features/usage/UsagePanel.jsx'
import { Kbd } from '../components/primitives.jsx'
import { DragRegion } from '../components/DragRegion.jsx'

export function App({ platform }: { platform: Platform }) {
  const attach = useStore((s) => s.attach)
  const setAppFocused = useStore((s) => s.setAppFocused)

  useEffect(() => {
    void attach(platform)
  }, [platform, attach])

  // 알림 정책이 "눈앞에 있으면 알리지 않는다"이므로 포커스 상태를 추적한다
  useEffect(() => {
    /*
       세 핸들러가 **같은 판정**을 쓴다.
       예전엔 visibilitychange만 visibility를 봤다 — 다른 앱으로 간 뒤 가림 이벤트가
       한 번 더 뜨면 창은 여전히 'visible'이라 다시 '눈앞'으로 돌아갔고,
       그때부터 알림이 조용히 막혔다. 자리를 비운 사람에게 알리는 게 이 앱의 전제인데.
     */
    // blur 시점에 document.hasFocus()가 아직 낡았을 수 있으므로, 아는 값은 직접 넘긴다
    const onFocus = () => setAppFocused(isForeground(true, document.visibilityState))
    const onBlur = () => setAppFocused(false)
    const onVisibility = () => setAppFocused(isForeground(document.hasFocus(), document.visibilityState))
    onVisibility()
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
        <CommandPalette />
        <Settings />
        <UsageModal />
        <Toast />
        <GlobalKeys />
      </div>
    </PlatformProvider>
  )
}

/** 프로젝트가 하나도 없으면 시작 안내가 화면을 대신한다 (FR-19) */
function Body() {
  const hasProjects = useStore((s) => Object.keys(s.projects).length > 0)
  // 훅은 **이른 return보다 먼저** — 아래 FirstRun 분기 뒤에 두면 렌더마다 훅 수가 달라진다
  const view = useStore((s) => s.view)

  if (!hasProjects) return <FirstRun />
  /*
    3레인. 좌 = 관찰, 중앙 = 조작, 우 = 증거.
    오버레이는 중앙과 우측을 함께 덮는다 — diff는 넓어야 읽힌다.
  */

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      {/*
        오버레이는 중앙·우측만 덮는다. 좌측(관찰 레인)까지 덮으면
        코드를 보는 동안 다른 세션이 나를 부르는 것을 놓친다 —
        관제탑에서 계기판을 가리는 셈이다.
      */}
      {/*
        min-w-0이 없으면 이 레인은 내용의 min-content 폭 아래로 줄지 못한다.
        그러면 패널을 넓혔을 때 레이아웃이 창 밖으로 밀려나 화면이 통째로
        가로 스크롤된다 (도그푸딩에서 나온 버그의 진짜 원인).
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/*
          컨트롤 센터에는 우측 증거 패널이 없다. 그리드가 이미 화면을 나눠 쓰는데
          거기서 또 한 레인을 떼면 패널이 최소 폭 아래로 내려간다 — 그리드를
          보류했던 근거(§5.4)를 우리 손으로 재현하는 셈이다.
        */}
        {view === 'grid' ? (
          <ControlCenter />
        ) : (
          <>
            <SessionView />
            <EvidencePanel />
          </>
        )}
        <Overlay />
      </div>
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

  // macOS 신호등(닫기·최소화·전체화면)이 왼쪽 위를 차지하므로 pl로 그만큼 비운다.
  // 타이틀바를 숨겼기 때문에 이 헤더가 유일한 드래그 손잡이다 —
  /*
   * 상단 바.
   *
   * data-tauri-drag-region이 없으면 창을 옮길 수 없다 (도그푸딩에서 지적됨).
   *
   * **신호등과 같은 축에 선다.** 처음엔 바를 타이틀바 높이(28px)로 줄여서 맞췄는데,
   * 그러니 바가 너무 얇아졌다. 신호등 위치는 tauri.conf.json의
   * `trafficLightPosition`으로 우리가 정할 수 있으므로, 이제 **바 높이를 먼저 정하고
   * 버튼을 거기에 맞춘다** — 화면이 요구하는 높이를 창 장식이 정하게 두지 않는다.
   *
   *   바 높이 36px, 버튼 지름 12px → y = (36 - 12) / 2 = 12
   *
   * 둘은 같이 움직여야 한다. 바 높이를 바꾸면 tauri.conf.json의 y도 함께 고쳐라
   * (tooling/styles.test.ts가 그 관계를 검사한다).
   */
  return (
    <DragRegion
      className="flex h-9 shrink-0 items-center gap-4 border-b border-edge bg-pit pr-4 pl-[86px]"
      testId="app-header"
    >
      <span
        className="pointer-events-none text-[12px] font-semibold tracking-[0.16em] text-chalk"
        data-testid="app-title"
      >
        CONTROL CENTER
      </span>

      <button
        className="group flex items-center gap-2.5 rounded px-2 py-0.5 transition-colors hover:bg-graphite/50"
        onClick={() => toggleInbox()}
        data-testid="counter"
        title="Waiting (⌘I)"
      >
        <Metric
          label="Approvals"
          value={counts.approval}
          tone={counts.approval > 0 ? 'beacon' : 'text-slate'}
          testId="count-approval"
        />
        <span className="text-edge">│</span>
        <Metric
          label="Waiting for input"
          value={counts.input}
          tone={counts.input > 0 ? 'text-ash' : 'text-slate'}
          testId="count-input"
        />
        {counts.error > 0 && (
          <>
            <span className="text-edge">│</span>
            <Metric label="Error" value={counts.error} tone="beacon" testId="count-error" />
          </>
        )}
      </button>

      <span className="flex items-center gap-1 text-[10px] text-slate">
        <Kbd live={waiting > 0}>⌘</Kbd>
        <Kbd live={waiting > 0}>I</Kbd>
        <span className="mr-2">List</span>
        <Kbd live={waiting > 0}>⌘</Kbd>
        <Kbd live={waiting > 0}>⇧</Kbd>
        <Kbd live={waiting > 0}>A</Kbd>
        Next item
      </span>

      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-slate" data-testid="connection">
          <span
            className={`size-1.5 rounded-full ${
              connection === 'connected' ? 'bg-ash' : 'bg-beacon breathe'
            }`}
            aria-hidden
          />
          {connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected'}
        </span>
        <button
          className="rounded px-2 py-1 text-[11px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={() => useStore.getState().toggleUsage(true)}
          data-testid="open-usage"
          title="Usage (plan limits)"
        >
          Usage
        </button>
        <button
          className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk"
          onClick={() => setAddOpen(true)}
          data-testid="add-project"
        >
          Add project
        </button>
      </span>

      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}
    </DragRegion>
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
      // 커맨드 팔레트 ⌘K (FR-17)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useStore.getState().togglePalette()
        return
      }
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
      // 증거 패널 토글 ⌘B — 탭 전환(⌘⇧1~4)을 대신한다.
      // 깃·파일은 대화를 대신하는 화면이 아니라 옆에 함께 두는 것이다.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useStore.getState().togglePanel()
        return
      }
      // 숫자 단축키는 e.code로 본다 — Shift를 누르면 e.key가 '#' 같은 기호가 된다 (E2E가 잡음)
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
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
