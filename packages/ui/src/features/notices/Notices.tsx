import { useEffect } from 'react'
import { useStore, type Notice } from '../../store/store.js'
import { isOnScreen } from '../../app/onscreen.js'

/**
 * 화면 밖에서 일어난 일들이 우측 상단에 쌓인다.
 *
 * **스스로 사라지지 않는다.** OS 배너는 몇 초 뒤 걷히는데, 자리를 비운 사이에 온 것은
 * 돌아왔을 때 이미 없다 — 배너가 가장 필요한 경우에 가장 못 쓰이는 셈이다. 여기 남는 카드는
 * 그 구멍을 메운다. (macOS에서는 배너 경로 자체가 죽어 있어 더더욱 이쪽이 본진이다.)
 *
 * 지나가는 신호인 은하수 바람과는 서로 배타적이다: 보고 있던 세션이 끝나면 바람,
 * 보고 있지 않던 세션이 끝나면 카드. 한 사건에 하나씩만 나간다.
 */
export function Notices() {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotices)
  const focusSession = useStore((s) => s.focusSession)
  const view = useStore((s) => s.view)
  const appFocused = useStore((s) => s.appFocused)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const orchestratorId = useStore((s) => s.orchestratorId)
  const gridPanels = useStore((s) => s.gridPanels)

  /*
   * 보게 된 것은 더 알릴 이유가 없다.
   *
   * 판정을 **여기 한 곳**에 둔다. 세션을 고를 때, 그리드에 올릴 때, 오케스트레이터를 열 때마다
   * 지우는 코드를 따로 두면 언젠가 한 경로를 빠뜨리고, 그때부터 안 지워지는 카드가 생긴다.
   * 어떤 경로로 보게 됐든 "지금 보이는가" 하나만 물으면 빠질 자리가 없다.
   *
   * **앱이 앞에 있는지도 함께 본다.** 만드는 쪽과 걷는 쪽이 같은 기준을 써야 한다 —
   * 앱이 뒤에 있는데 걷어 버리면, 자리를 비운 사이 온 카드가 돌아오기도 전에 사라진다.
   * 그러면 정확히 필요한 경우에만 못 보는 카드가 된다. 돌아오는 순간 이 효과가 다시 돌면서
   * 그때 걷힌다.
   */
  useEffect(() => {
    if (!appFocused) return
    dismiss(
      notices
        .filter((n) => isOnScreen(view, n.sessionId, { focusedSessionId, orchestratorId, gridPanels }))
        .map((n) => n.sessionId),
    )
  }, [notices, appFocused, view, focusedSessionId, orchestratorId, gridPanels, dismiss])

  if (notices.length === 0) return null

  return (
    <div
      /*
       * 화면을 넘기지 않는다. 카드는 세션당 하나라 수가 세션 수를 넘지 않지만,
       * 세션이 스무 개면 그것만으로도 화면 밖으로 나간다 — 나간 카드는 없는 카드다.
       */
      className="absolute right-3 top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[300px] flex-col gap-1.5 overflow-y-auto"
      data-testid="notices"
    >
      {notices.map((n) => (
        <NoticeCard
          key={n.sessionId}
          notice={n}
          onOpen={() => focusSession(n.sessionId, { preferGrid: true })}
          onClose={() => dismiss([n.sessionId])}
        />
      ))}
    </div>
  )
}

/** 무슨 일인지 — 색을 거의 쓰지 않는 화면이라 왼쪽 선 하나로 가른다 */
const LOOK: Record<Notice['kind'], { label: string; edge: string }> = {
  approval: { label: 'Awaiting approval', edge: 'border-l-beacon' },
  error: { label: 'Error', edge: 'border-l-[var(--color-del)]' },
  done: { label: 'Finished', edge: 'border-l-graphite' },
}

function NoticeCard({
  notice,
  onOpen,
  onClose,
}: {
  notice: Notice
  onOpen: () => void
  onClose: () => void
}) {
  const look = LOOK[notice.kind]
  return (
    <div
      className={`flex items-start gap-2 rounded border border-edge ${look.edge} border-l-2 bg-panel py-2 pl-2.5 pr-1.5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.9)]`}
      data-testid="notice"
      data-kind={notice.kind}
      data-session={notice.sessionId}
    >
      {/* 카드 전체가 그 세션으로 가는 문이다 — 작은 과녁을 겨누게 하지 않는다 */}
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        data-testid="notice-open"
        onClick={onOpen}
        title="Open this session"
      >
        <div className="truncate text-[12px] text-chalk">{notice.name}</div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-slate">{look.label}</div>
      </button>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-[12px] leading-none text-slate hover:bg-edge hover:text-chalk"
        data-testid="notice-close"
        onClick={onClose}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
