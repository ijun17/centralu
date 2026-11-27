import { useLayoutEffect, useRef, useState } from 'react'
import { appKeyOf, isAway, type SessionSummary } from '@cc/core'
import type { ExternalAppStatus } from '@cc/protocol/client'
import { appSessionsNeedAttention } from '../tree.js'
import { useStore } from '../../../store/store.js'
import { AppIcon, StopIcon } from '../../../components/icons.jsx'
import { IconButton } from '../../../components/IconButton.jsx'
import { isRemoteUserApp, type ExternalCatalogApp } from '../../../store/app-catalog.js'
import { MachineBadge, MachineBadgePlaceholder } from '../../machines/MachineTag.jsx'
import { APP_MIME, projectItemMime } from '../reorder.js'
import { groupAttention } from '../fold.js'
import { INDENT, ROW_PAD, ROW_PAD_IDLE } from '../layout.js'
import { GroupToggle } from '../rows/GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from '../rows/groupFold.js'

/**
 * An app row (M4 B-2): a session row's shape with a window icon for a mark. Status is one word at the right, none for
 * idle, running or stopped (an app stops when idle), so "failed" stands out. An app that cannot open has its mark dimmed.
 */
const APP_HINT: Partial<Record<ExternalAppStatus, string>> = {
  starting: 'starting',
  crashed: 'crashed',
  failed: 'failed',
  untrusted: 'not trusted',
  invalid: 'invalid',
  // An imported app awaits confirmation (M4 E-3); opening it asks
  unconfirmed: 'not enabled',
}

export function AppRow({
  app,
  sessions,
  folded,
  onFold,
}: {
  app: ExternalCatalogApp
  /** The sessions this app owns: what its chevron folds (#666) */
  sessions: SessionSummary[]
  folded: boolean
  onFold: (folded: boolean) => void
}) {
  const openApp = useStore((s) => s.openApp)
  const stopApp = useStore((s) => s.stopApp)
  // A linked machine's user-folder app (#82, remote-hub.md §11) names its machine; a project app's id already does
  const remote = isRemoteUserApp(app.info)
  const machine = remote ? (app.info.machine ?? null) : null
  // Lit only while its screen is shown, as a session row (useSelectedSessionId)
  const active = useStore(
    (s) => s.view === 'app' && !!s.focusedApp && appKeyOf(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) === app.key,
  )
  // A chain from this app's screen waits on an answer (M4 D-4); questions are this computer's, so a remote app never matches
  const asking = useStore(
    (s) => !remote && s.appQuestions.some((q) => q.origin.appId === app.appId && (q.origin.projectId ?? null) === app.projectId),
  )
  // `sessions` are picked by the caller, by machine too (#82): a machine-less filter here would take another machine's session
  const waitsForYou = asking || appSessionsNeedAttention(sessions)
  // An app running background work (#1236) has Stop on its row; what it does is the icon's tooltip, not text (#1928)
  const busy = app.info.status === 'running' && app.info.busy ? `Running: ${app.info.busy}` : null
  const hint = waitsForYou ? 'asks you' : APP_HINT[app.info.status]
  const projectId = app.projectId
  // Dimmed while its machine is not connected (#734)
  const away = useStore((s) => isAway({ machine }, s.machines))
  /*
   * The badge is a button, so it cannot sit in the row's button: the row holds an invisible placeholder and the badge, a
   * sibling, stands over it (#734). Measured in layout pixels on both sides, so text zoom cancels out.
   */
  const badgePlace = useRef<HTMLSpanElement>(null)
  const [badgeAt, setBadgeAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = badgePlace.current
    if (!el) return
    const place = () =>
      setBadgeAt((was) => (was && was.left === el.offsetLeft && was.top === el.offsetTop ? was : { left: el.offsetLeft, top: el.offsetTop }))
    place()
    const watch = new ResizeObserver(place)
    if (el.parentElement) watch.observe(el.parentElement)
    watch.observe(el)
    return () => watch.disconnect()
  })
  return (
    <li
      className={`relative ${INDENT[1]} pr-1.5 ${away ? 'opacity-60' : ''}`}
      data-level={1}
      data-folded={folded || undefined}
      /*
        Onto the grid (#288) or its project screen (#203). A user-folder app carries no project type, so every project
        screen refuses it. Another machine's app too (#82, remote-hub.md §11.8).
      */
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(APP_MIME, app.key)
        if (projectId) e.dataTransfer.setData(projectItemMime(projectId), projectId)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      {sessions.length > 0 && (
        <GroupToggle
          folded={folded}
          label={`${folded ? 'Show' : 'Hide'} the ${sessions.length === 1 ? 'session' : `${sessions.length} sessions`} of ${app.title}`}
          testId={`app-fold-${app.key}`}
          onToggle={() => onFold(!folded)}
        />
      )}
      <button
        type="button"
        onClick={() => openApp(app.projectId, app.appId, { machine })}
        onKeyDown={foldKeys(sessions.length > 0, folded, onFold)}
        data-testid={`app-row-${app.key}`}
        data-status={app.info.status}
        aria-current={active ? 'page' : undefined}
        title={app.status.reason ?? app.info.description ?? undefined}
        className={`flex w-full items-center gap-2 py-1.5 ${busy ? 'pr-9' : 'pr-3'} text-left text-md transition-colors ${
          active
            ? `rounded-r-md border-l-2 border-l-ink-muted bg-surface-hover/40 ${ROW_PAD} text-ink`
            : `rounded-md ${ROW_PAD_IDLE} text-ink-muted hover:bg-surface-hover/25 hover:text-ink hover:ring-1 hover:ring-inset hover:ring-line`
        }`}
      >
        {/* The tool chip's width (17px), so names start in one column */}
        <span className={`flex size-[17px] shrink-0 items-center justify-center ${app.status.runnable ? '' : 'opacity-50'}`}>
          <AppIcon />
        </span>
        <span className="truncate">{app.title}</span>
        {machine && <MachineBadgePlaceholder ref={badgePlace} machine={machine} />}
        {folded && sessions.length > 0 && (
          <FoldedMark count={sessions.length} attention={groupAttention(sessions)} testId={`app-folded-${app.key}`} />
        )}
        {hint && (
          <span
            className={`readout ml-auto shrink-0 text-2xs ${waitsForYou || app.status.tone === 'alert' ? 'text-ink' : 'text-ink-faint'}`}
            data-testid="app-row-hint"
            data-asking={waitsForYou || undefined}
          >
            {hint}
          </span>
        )}
      </button>
      {busy && (
        // A sibling of the row: a button inside a button is neither valid nor reachable by keyboard
        <span className="absolute right-2 top-1/2 flex -translate-y-1/2">
          <IconButton
            label={`Stop ${app.title}: running ${app.info.busy}. It starts again the next time something needs it`}
            onClick={() => void stopApp({ key: app.key, appId: app.appId, projectId: app.projectId, machine })}
            testId={`app-stop-${app.key}`}
            align="right"
          >
            <StopIcon />
          </IconButton>
        </span>
      )}
      {machine && (
        <MachineBadge
          machine={machine}
          testId={`app-machine-${app.key}`}
          className={`absolute ${badgeAt ? '' : 'invisible'}`}
          style={badgeAt ? { left: badgeAt.left, top: badgeAt.top } : undefined}
        />
      )}
    </li>
  )
}
