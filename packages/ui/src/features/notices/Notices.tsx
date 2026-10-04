import { useEffect } from 'react'
import { gridSessionIds } from '@cc/core'
import { projectScreenSessions, useStore, type Notice } from '../../store/store.js'
import { isOnScreen } from '../../app/onscreen.js'

/**
 * Things that happened off screen stack up in the top right.
 *
 * **It does not disappear on its own.** An OS banner clears itself after a few seconds, so
 * anything that arrived while the person was away is already gone by the time they come back —
 * a banner is least usable exactly when it is needed most. The card that stays here fills that
 * gap. (On macOS the banner path is dead anyway, which makes this the primary channel all the
 * more.)
 *
 * Mutually exclusive with the passing signal, the milky-way wind: if the session being watched
 * finishes, it is a wind; if a session not being watched finishes, it is a card. Exactly one of
 * the two goes out per event.
 */
export function Notices() {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotices)
  const focusSession = useStore((s) => s.focusSession)
  const view = useStore((s) => s.view)
  const appFocused = useStore((s) => s.appFocused)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const orchestratorId = useStore((s) => s.orchestratorId)
  // Joined for the same reason as below — the grid's sessions, derived from its panels (#288)
  const gridSessions = useStore((s) => gridSessionIds(s.gridPanels).join(' '))
  const builderPaneSessionId = useStore((s) => s.builderPaneSessionId)
  // Joined into one string: a selector that returns a new array on every call never settles
  const projectScreen = useStore((s) => projectScreenSessions(s).join(' '))

  /*
   * There is no reason to keep notifying about something that has now been seen.
   *
   * The check lives in **one place, here**. Putting separate clearing code at every path —
   * selecting a session, putting it in the grid, opening the orchestrator — would eventually
   * miss one path, and from that point a card would exist that never clears. Whatever path led
   * to it being seen, asking only "is it visible right now" leaves no gap for a card to fall
   * through.
   *
   * **Whether the app itself is in front is checked too.** The side that creates a card and the
   * side that clears it have to use the same standard — clearing while the app is in the
   * background would make a card that arrived while the person was away vanish before they even
   * come back. That would turn it into a card missed in exactly the case it exists for. The
   * moment the person returns, this effect runs again and clears it then.
   */
  useEffect(() => {
    if (!appFocused) return
    dismiss(
      notices
        .filter((n) =>
          isOnScreen(view, n.sessionId, {
            focusedSessionId,
            orchestratorId,
            gridSessions: gridSessions ? gridSessions.split(' ') : [],
            builderPaneSessionId,
            projectScreen: projectScreen ? projectScreen.split(' ') : [],
          }),
        )
        .map((n) => n.sessionId),
    )
  }, [notices, appFocused, view, focusedSessionId, orchestratorId, gridSessions, builderPaneSessionId, projectScreen, dismiss])

  if (notices.length === 0) return null

  return (
    <div
      /*
       * Does not spill past the screen. There is one card per session, so the count never
       * exceeds the session count, but with twenty sessions that alone runs off screen — a card
       * that has run off screen is a card that does not exist.
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

/** What happened — since this screen barely uses color, a single line on the left distinguishes it */
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
      {/* The whole card is the door to that session — nobody has to aim at a small target */}
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        data-testid="notice-open"
        onClick={onOpen}
        title="Open this session"
      >
        <div className="truncate text-[12px] text-chalk">{notice.name}</div>
        <div className="mt-0.5 text-[10px] uppercase text-slate">{look.label}</div>
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
