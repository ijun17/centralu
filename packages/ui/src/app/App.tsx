import { useEffect } from 'react'
import { nextWaitingSession } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider, useCapability } from './PlatformProvider.jsx'
import { useShortcut } from './shortcut.js'
import { isForeground } from './foreground.js'
import { Gust } from './Gust.jsx'
import { useStore } from '../store/store.js'
import { useCounts, computeInbox } from '../store/selectors.js'
import { Sidebar } from '../features/sidebar/Sidebar.jsx'
import { EvidencePanel } from '../features/evidence/EvidencePanel.jsx'
import { Overlay } from '../features/evidence/Overlay.jsx'
import { SessionView } from '../features/session/SessionView.jsx'
import { GridView } from '../features/grid/GridView.jsx'
import { OrchestratorView } from '../features/orchestrator/OrchestratorView.jsx'
import { Inbox } from '../features/inbox/Inbox.jsx'
import { ApprovalBanner } from '../features/approval/ApprovalBanner.jsx'
import { FirstRun } from '../features/onboarding/FirstRun.jsx'
import { CommandPalette } from '../features/palette/CommandPalette.jsx'
import { Settings } from '../features/settings/Settings.jsx'
import { UpdateLine } from '../features/settings/UpdateLine.jsx'
import { Notices } from '../features/notices/Notices.jsx'
import { UsageModal } from '../features/usage/UsagePanel.jsx'
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
        <Gust />
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
    The overlay covers the middle lane only — see the note below.
  */

  /*
    The grid and the orchestrator have no evidence lane. The grid already splits the screen;
    taking one more lane out of it drops the panel below its minimum width, which reproduces
    by our own hand the very thing that got the grid shelved (§5.4).
  */
  const hasEvidenceLane = view !== 'orchestrator' && view !== 'grid'

  return (
    // relative: 알림 카드가 이 안에 떠야 한다. 앱 전체에 걸면 상단 바와 승인 배너를
    // 덮어서, 배너의 버튼을 카드가 가로챈다 (e2e가 클릭이 막히는 것으로 잡아냈다).
    <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      <Notices />
      {/*
        The overlay is confined to this lane, and that is why it lives inside this div
        rather than beside it. Covering the left lane would mean missing another session
        calling for me while I read code — blinding the instruments in the control tower.
        Covering the right lane turned out to be just as bad in a quieter way.

        It used to cover the right lane too, on the grounds that "340px can't hold a diff".
        That is a true sentence and the wrong conclusion: it answers why the overlay is not
        rendered *inside* the panel, not why it should *hide* the panel. The overlay is not
        competing with the panel for width — it is competing with the conversation. What
        the panel holds is the file tree and the change list, which is how you open the
        next file, so the loop people were left with was: click a file, watch the tree
        disappear, press escape, click the next one (issue #15). The diff does get ~340px
        narrower; it is unified, not side-by-side, so that costs line width and not a
        column, and the tree stays where your hand already is.
      */}
      {/*
        min-w-0이 없으면 이 레인은 내용의 min-content 폭 아래로 줄지 못한다.
        그러면 패널을 넓혔을 때 레이아웃이 창 밖으로 밀려나 화면이 통째로
        가로 스크롤된다 (도그푸딩에서 나온 버그의 진짜 원인).
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {view === 'orchestrator' ? <OrchestratorView /> : view === 'grid' ? <GridView /> : <SessionView />}
        <Overlay />
      </div>
      {hasEvidenceLane && <EvidencePanel />}
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

  // 왼쪽 위를 창 버튼이 차지하면 그만큼 비운다. 타이틀바를 숨겼기 때문에
  // 이 헤더가 유일한 드래그 손잡이다 —
  //
  // How much to leave is a platform fact, so we ask instead of assuming. It was
  // `pl-[86px]`, which is right on macOS (the traffic lights sit inside this bar) and
  // wrong everywhere else: on desktops that draw their own decorations above us, the
  // same padding is just a hole at the left edge with nothing in it.
  const controlsInset = useCapability('windowControlsInset')
  const sc = useShortcut()
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
      className="flex h-9 shrink-0 items-center gap-4 border-b border-edge bg-pit pr-4"
      style={{ paddingLeft: controlsInset }}
      testId="app-header"
    >
      <span
        /*
         * No tracking at all — the name is set like ordinary text.
         *
         * It went 0.16em (wider than anything else on screen) → 0.12em, the app's uppercase
         * label tracking → 0.06em → none, and every step read better than the one before.
         * That direction is the answer: this is a name, not a label. A label is scanned
         * letter by letter and tracking is what pays for that; a name is taken in as one
         * shape, and this one is read least of anything here — you already opened the app.
         * Set flush it stops being spelled out and just sits there being the title.
         */
        className="pointer-events-none text-[12px] font-semibold text-chalk"
        data-testid="app-title"
      >
        CENTRALU
      </span>

      <button
        className="group flex items-center gap-2.5 rounded px-2 py-0.5 transition-colors hover:bg-graphite/50"
        onClick={() => toggleInbox()}
        data-testid="counter"
        title={`Waiting (${sc('mod', 'I')})`}
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

      {/*
        단축키 칩(⌘I · ⌘⇧A)은 여기 없다 (이슈 #33).

        They sat beside the count and brightened with it, so at the one moment the bar has
        something to say — something is waiting — two of the three bright things were
        instructions. A shortcut hint is worth reading once and then never again, but a chip
        on the dashboard charges attention on every glance, forever. 계기판은 상태를 말하는
        자리다.

        **밝아지는 것은 숫자가 계속 맡는다.** 칩이 켜지던 조건은 `waiting > 0` 하나였는데,
        숫자는 이미 종류별로(승인은 beacon, 응답대기는 ash) 자기 밝기를 갖고 있다 —
        더 정확한 신호가 이미 그 자리에 있었고, 칩은 거기 편승했을 뿐이다.

        Where they went: named with their keys in Settings → Shortcuts, and runnable from
        the command palette (⌘K). Deleting the only visible mention was the failure to avoid,
        so the palette gained both entries in the same change.
      */}
      <span className="ml-auto flex items-center gap-3">
        {/*
          "새 버전이 있습니다" — 있을 때만 나타나는 한 줄 (이슈 #43).

          단축키 칩을 걷어낸 자리(위 주석)에 무언가를 다시 놓는 셈인데, 성질이 반대다:
          칩은 늘 켜져 있으면서 처음 한 번 뒤로는 아무것도 알려주지 않았고, 이 줄은
          평소엔 아예 없다가 계기판이 할 말이 생겼을 때만 선다. 그리고 이것도 상태다 —
          "이 앱은 지금 최신이 아니다"는 계기판이 답할 만한 질문이다.
        */}
        <UpdateLine />
        {/*
          연결됨은 **slate가 아니라 ash**다.

          slate는 팔레트에서 '배경 정보' 자리다. 상태 표시를 거기 두면 정상인데도 꺼진 것으로
          읽힌다 — 회색 글자는 "지금 없는 것"의 관습이라, 라벨이 Connected여도 눈은 글자보다
          색을 먼저 읽는다. 점만 ash였고 글자는 slate라 표시 전체가 그렇게 내려앉아 있었다.

          그렇다고 밝히지는 않는다. 연결됨은 기본 상태라 조용한 게 맞고, 밝기는 급한 것에 쓰는
          자원이다. 하려는 일은 눈을 끄는 게 아니라 **'꺼짐'과 구별되는 것**이므로 한 단계만 올린다.

          끊김 쪽은 beacon으로 올린다. 글자를 slate로 남겨 두면 급한 쪽이 정상보다 어두워져
          "화면에서 가장 밝은 것 = 나를 기다리는 것"이 뒤집힌다 — 점은 이미 beacon인데
          글자만 뒤에 남아 있었고, 그래서 두 상태가 글자로는 같은 밝기였다.
        */}
        <span
          className={`flex items-center gap-1.5 text-[11px] ${
            connection === 'connected' ? 'text-ash' : 'text-beacon'
          }`}
          data-testid="connection"
        >
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
        {/*
          설정에는 입구가 커맨드 팔레트 하나뿐이었다. 그런데 그 안에 **단축키 표**가 들어 있다 —
          단축키를 이미 아는 사람만 단축키 표를 볼 수 있었던 셈이다. 도그푸딩에서 "설정이
          안 보이는데?"로 드러났다. 흐름을 강요하지 않는 것과 입구를 감추는 것은 다르다.
        */}
        <button
          className="rounded px-2 py-1 text-[11px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={() => useStore.getState().toggleSettings(true)}
          data-testid="open-settings"
          title="Settings (shortcuts · notifications · approval rules)"
        >
          Settings
        </button>
        {/*
          'Add project'는 여기 있었다. 사이드바 맨 아래로 옮겼다 (이슈 #4) —
          누르는 곳(화면 오른쪽 끝)과 결과가 나타나는 곳(왼쪽 사이드바)이 화면을
          가로질러 떨어져 있었다. 상단 바는 **계기판**이라, 무언가를 만드는 버튼이
          숫자들 옆에 서면 읽는 것과 하는 것이 한 줄에 섞인다.
        */}
      </span>
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
    /*
      z-30 — the same tier as the notice cards, and above the overlay (z-20).

      Without it this is an opaque pill painted *underneath* the wide surface, so every
      failure reported while a file or a diff is open said nothing at all. That is the one
      state where the toast matters most: the overlay covers the lane the pill sits in, and
      what it covers up is the app's whole answer to "that didn't work".
    */
    <div
      className="absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded border border-edge bg-panel px-3 py-2 text-[12px] text-chalk shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      data-testid="toast"
      role="status"
    >
      {toast}
    </div>
  )
}
