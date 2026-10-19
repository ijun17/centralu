import { useLayoutEffect, useRef, useState } from 'react'
import { isAway, type SessionSummary } from '@cc/core'
import type { ExternalAppStatus } from '@cc/protocol'
import { appSessionsNeedAttention } from '../tree.js'
import { externalAppKey, useStore } from '../../../store/store.js'
import { AppIcon } from '../../../components/icons.jsx'
import { isRemoteUserApp, type ExternalCatalogApp } from '../../../store/app-catalog.js'
import { MachineBadge, MachineBadgePlaceholder } from '../../machines/MachineTag.jsx'
import { APP_MIME, projectItemMime } from '../reorder.js'
import { groupAttention } from '../fold.js'
import { INDENT, ROW_PAD } from '../layout.js'
import { GroupToggle } from '../rows/GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from '../rows/groupFold.js'

/**
 * An app row (M4 B-2) — same shape, same spot as a session row. Pressing it opens the pinned app
 * screen.
 *
 * So sessions and apps standing in one list do not read as mixed together, the mark is split by
 * **shape** (a session gets a tool-letter chip, an app gets a window icon). Status is a single word
 * at the far right, and nothing at all is written for the normal cases (idle, running). Since an
 * app comes up on first need and goes down when idle, "stopped" is ordinary, not a breakage. If it
 * were always written, the one word that actually matters (failed) would get buried. An app that
 * cannot be opened (untrusted, broken, stalled) has its mark dimmed, and the reason is visible by
 * staying on the row.
 */
const APP_HINT: Partial<Record<ExternalAppStatus, string>> = {
  starting: 'starting',
  crashed: 'crashed',
  failed: 'failed',
  untrusted: 'not trusted',
  invalid: 'invalid',
  // An imported app is waiting for the person's confirmation (M4 E-3) — opening it brings up the confirmation dialog
  unconfirmed: 'not enabled',
}

export function AppRow({
  app,
  sessions,
  folded,
  onFold,
}: {
  app: ExternalCatalogApp
  /** The sessions this app owns: what its chevron folds, counted and checked for attention when folded (#666) */
  sessions: SessionSummary[]
  folded: boolean
  onFold: (folded: boolean) => void
}) {
  const openApp = useStore((s) => s.openApp)
  const stopApp = useStore((s) => s.stopApp)
  /*
   * A linked machine's user-folder app (#82) opens like this computer's, through the hub (remote-hub.md §11); only
   * its machine has to be named, since it has no project to say so. A project app's id already names its machine.
   */
  const remote = isRemoteUserApp(app.info)
  const machine = remote ? (app.info.machine ?? null) : null
  // Same rule as a session row: lit only while **currently looking at** that screen (useSelectedSessionId in selectors)
  const active = useStore(
    (s) => s.view === 'app' && !!s.focusedApp && externalAppKey(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) === app.key,
  )
  /*
   * A chain started from this app's screen is waiting on the person's answer (M4 D-4) — visible
   * here even without the pinned app screen open. Pressing it opens that screen, with the question
   * standing there. Written in a bright word: that belongs to whatever is blocked (the palette rule).
   */
  // The questions are this computer's own (another machine's stay there), so another machine's user-folder app never matches one
  const asking = useStore(
    (s) => !remote && s.appQuestions.some((q) => q.origin.appId === app.appId && (q.origin.projectId ?? null) === app.projectId),
  )
  /*
   * The sessions the row was given are the app's own, picked by whoever draws the row: by project for a project app, and by
   * machine as well for a user-folder app, where two machines can have one id (#82). Not picked again here from all sessions,
   * where a machine-less filter takes another machine's session for this computer's.
   */
  const waitsForYou = asking || appSessionsNeedAttention(sessions)
  /*
   * An app keeping itself running for background work (#1236) says what it is doing, and has Stop right on its row: a
   * process that stays with nothing open is something the person should see and be able to end, an app with no view
   * included (its view and Settings' app row have Stop too)
   */
  const busy = app.info.status === 'running' && app.info.busy ? `Running: ${app.info.busy}` : null
  const hint = waitsForYou ? 'asks you' : (busy ?? APP_HINT[app.info.status])
  const projectId = app.projectId
  // A linked machine's user-folder app keeps the dimming its machine's group gave it while that machine is not connected (#734)
  const away = useStore((s) => isAway({ machine }, s.machines))
  /*
   * Its machine's badge is a button, and the row is one: a button inside a button is neither valid nor reachable by
   * keyboard. So the row holds the badge's place (an invisible chip of the same size, right after the title, where the
   * title's truncation moves it) and the badge stands over that place as the row's sibling (#734). Measured after
   * every render and whenever the row's box changes, in layout pixels on both sides, so the text zoom cancels out.
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
      className={`relative ${INDENT[1]} ${away ? 'opacity-60' : ''}`}
      data-level={1}
      data-folded={folded || undefined}
      /*
        An app row is dragged like a session row: onto the grid, any app (#288), or onto its
        project screen, a project's app (#203), where an absent panel is added where it is dropped.
        A user-folder app carries no project type, so every project screen refuses it while it is
        still being dragged. Another machine's app is dragged the same way (#82): the hub keeps its
        grid panel while it knows that machine and project (remote-hub.md §11.8), and the row's key
        names the machine of a user-folder app.
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
        className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} ${busy ? 'pr-14' : 'pr-3'} text-left text-md transition-colors ${
          active ? 'border-l-ink-muted bg-surface-hover/40 text-ink' : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
        }`}
      >
        {/* Same width as the tool chip (17px) — a session name and an app name start at the same vertical column */}
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
            className={`readout ml-auto text-2xs ${busy && !waitsForYou ? 'min-w-0 max-w-[60%] truncate' : 'shrink-0'} ${waitsForYou || app.status.tone === 'alert' ? 'text-ink' : 'text-ink-faint'}`}
            data-testid="app-row-hint"
            data-asking={waitsForYou || undefined}
            data-busy={(busy && !waitsForYou) || undefined}
            title={busy && !waitsForYou ? busy : undefined}
          >
            {hint}
          </span>
        )}
      </button>
      {busy && (
        // A sibling of the row, not inside it: a button inside a button is neither valid nor reachable by keyboard
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
          onClick={() => void stopApp({ key: app.key, appId: app.appId, projectId: app.projectId, machine })}
          title={`${busy}. Stop it; it starts again the next time something needs it`}
          aria-label={`Stop ${app.title}`}
          data-testid={`app-stop-${app.key}`}
        >
          Stop
        </button>
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
