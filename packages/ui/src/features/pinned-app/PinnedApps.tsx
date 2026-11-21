import { TrustProjectButton } from '../project/TrustCard.jsx'
import { appKeyOf } from '@cc/core'
import { sameApp } from '@cc/protocol/client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { gridScreenAppKeys, projectScreenAppKeys, registerPinnedFrame, returnsToPanel, useStore, type PinnedView } from '../../store/store.js'
import { type ExternalCatalogApp, useExternalApp, viewMustClose } from '../../store/app-catalog.js'
import { projectLabelOf } from '../../store/names.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { Button } from '../../components/Button.jsx'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { RunsPanel } from './RunsPanel.jsx'
import { MessageAsk } from './MessageAsk.jsx'
import { useMessageAsk } from './useMessageAsk.js'
import { BuilderPane } from './BuilderPane.jsx'
import { ErrorTail } from './ErrorTail.jsx'
import { FixBar } from './FixBar.jsx'
import { useAppBuilder } from './useAppBuilder.js'
import { UpdatedCue } from './UpdatedCue.jsx'
import { CapabilityAsk } from './CapabilityAsk.jsx'
import { SecretsPanel, missingSecrets } from './AppSecrets.jsx'
import { ReviewAndEnable } from '../app-share/ReviewAndEnable.jsx'
import { VersionsPanel } from '../app-share/VersionsPanel.jsx'
import { registerSlottedView } from './slots.js'
import { registerShieldHost } from './dragShield.jsx'

/**
 * Where a pinned view is drawn: `full` is the app view; `slot` lies over its panel on the project screen (#203) or the
 * grid (#288, slots.ts), without a header; `hidden` is alive and out of sight.
 */
type Mode = 'full' | 'slot' | 'hidden'

/**
 * A hidden view: moved past the window's left edge at the lane's size, and `inert`. Never `display: none` or
 * `visibility: hidden`, on it or around it (docs/apps/views.md "Pinned, in the main area", #309): in WKWebView either
 * one leaves empty scrollbar gutters once shown again, and scrolling from script does not restore them. Measured with
 * macOS 27's WebKit, legacy scrollbars, a nested frame; `opacity: 0` and moving out kept them. e2e cannot show it:
 * Playwright's WebKit forces overlay scrollbars, which take no gutter. `-200vw`: the lane is narrower than the window,
 * so the box lies wholly left of it, and a negative offset adds nothing to scroll to.
 */
const OUT_OF_SIGHT = 'absolute inset-y-0 -left-[200vw] flex w-full min-h-0 min-w-0 flex-col'

/**
 * The pinned view (M4 B-2): an app opened from the sidebar takes the main area. Every open view stays mounted, one
 * visible: the spec's "a view holds no state" means it reads fresh on return, but a remount loses typed fields, scroll
 * and expanded lists and resends `home`, and a detached or moved iframe loses its document. So this layer is always
 * App's center-lane child, never moving. Three ways down, each sending teardown first (AppFrame's contract): close (×),
 * the app is gone (folder or project deleted), or it can no longer run (its view's HTML is that project's code).
 */
export function PinnedApps() {
  const pinned = useStore((s) => s.pinnedViews)
  const showing = useStore((s) => s.view === 'app')
  const focusedKey = useStore((s) => (s.focusedApp ? appKeyOf(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) : null))
  // The views over panels, the project screen's or the grid's (#288; one screen shows at a time). Joined into a string:
  // a selector returning a new array each call never settles
  const slotted = useStore((s) => [...projectScreenAppKeys(s), ...gridScreenAppKeys(s)].join('\n'))
  const slots = new Set(slotted ? slotted.split('\n') : [])
  const modeOf = (key: string): Mode => (showing ? (key === focusedKey ? 'full' : 'hidden') : slots.has(key) ? 'slot' : 'hidden')
  return (
    // Outside the app view this layer takes no room (`contents`), never `hidden` (see OUT_OF_SIGHT). Only the class
    // changes, never the parent, so no frame leaves the document.
    <div className={showing ? 'flex min-h-0 min-w-0 flex-1' : 'contents'} data-testid="pinned-apps">
      {pinned.map((pv) => (
        <PinnedAppView key={pv.key} pv={pv} mode={modeOf(pv.key)} />
      ))}
    </div>
  )
}

function PinnedAppView({ pv, mode }: { pv: PinnedView; mode: Mode }) {
  // What only the app view has — the header, the side panels, the builder beside it
  const visible = mode === 'full'
  const section = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = section.current
    if (mode !== 'slot' || !el) return
    return registerSlottedView(pv.key, el)
  }, [mode, pv.key])
  // Where the panel lays its cover over this view while something is dragged (dragShield.tsx)
  const shieldHost = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = shieldHost.current
    if (mode !== 'slot' || !el) return
    return registerShieldHost(pv.key, el)
  }, [mode, pv.key])
  // A hidden view lets go of the keyboard (#115): WebKit keeps focus in a frame that turns inert (measured, Playwright's
  // WebKit), so when a notification, the global shortcut or the store hides it, keys would go into an unseen view.
  useLayoutEffect(() => {
    const el = section.current
    if (mode !== 'hidden' || !el) return
    const held = document.activeElement
    if (!(held instanceof HTMLElement) || !el.contains(held)) return
    held.blur()
    // In WebKit the blur leaves focus in the view's nested frame; focusing this window takes it back
    window.focus()
  }, [mode])
  const app = useExternalApp(pv.projectId, pv.appId, pv.machine)
  const frame = useRef<AppFrameHandle>(null)
  const start = useStore((s) => s.startPinnedView)
  const release = useStore((s) => s.releasePinnedView)
  const close = useStore((s) => s.closeApp)
  const setToast = useStore((s) => s.setToast)
  const scope = useStore((s) => (pv.projectId ? projectLabelOf(s.projects, pv.projectId) : 'Other apps'))
  // The Runs panel (B-7), open per view: another app shows its own state
  const [runsOpen, setRunsOpen] = useState(false)
  // The Secrets panel (M4 E), for an app that declares secrets; the button counts unset ones
  const [secretsOpen, setSecretsOpen] = useState(false)
  // The Versions panel (M4 E-1): snapshots and a way back for a user-folder app; git's commits (read-only) for a project app
  const [versionsOpen, setVersionsOpen] = useState(false)
  const missing = missingSecrets(app)
  // The builder session (C-5): the input row sends into it; its conversation opens beside the view (BuilderPane)
  const builder = useAppBuilder(pv.projectId, pv.appId, pv.machine)
  const [builderOpen, setBuilderOpen] = useState(false)
  // A builder's conversation beside the view is on screen: its turn ending is a breeze, not a card (`isOnScreen`)
  const setBuilderPane = useStore((s) => s.setBuilderPane)
  const paneSession = builderOpen && visible && builder.id ? builder.id : null
  useEffect(() => {
    if (!paneSession) return
    setBuilderPane(paneSession)
    return () => {
      if (useStore.getState().builderPaneSessionId === paneSession) setBuilderPane(null)
    }
  }, [paneSession, setBuilderPane])
  // "Show the conversation" (FixBar, ErrorTail): a slot draws no pane (too narrow for 380px beside the app), so from a
  // panel it opens the app view with the pane, through `openApp` like the panel's Open (on the grid, the app's own view, #288)
  const openApp = useStore((s) => s.openApp)
  // Builder and Runs open in place in the app view, else open it with the panel asked. A linked machine's user-folder
  // app names its machine too (#82), or this computer's app of the same id would open
  const showPanel = (panel: 'builder' | 'runs') => {
    if (visible) (panel === 'builder' ? setBuilderOpen : setRunsOpen)(true)
    else openApp(pv.projectId, pv.appId, { builder: panel === 'builder', runs: panel === 'runs', machine: pv.machine })
  }
  const showBuilder = () => showPanel('builder')
  const showRuns = () => showPanel('runs')
  const paneAsked = useStore((s) => s.builderPaneFor === pv.key)
  const takePaneAsk = useStore((s) => s.takeBuilderPaneFor)
  useEffect(() => {
    if (!paneAsked || !visible) return
    setBuilderOpen(true)
    takePaneAsk(pv.key)
  }, [paneAsked, visible, pv.key, takePaneAsk])
  const runsAsked = useStore((s) => s.runsPanelFor === pv.key)
  const takeRunsAsk = useStore((s) => s.takeRunsPanelFor)
  useEffect(() => {
    if (!runsAsked || !visible) return
    setRunsOpen(true)
    takeRunsAsk(pv.key)
  }, [runsAsked, visible, pv.key, takeRunsAsk])
  // A capability question from this view's chain (M4 D-4), oldest first. Filtered here: a selector returning a new
  // array would change on every store change
  const questions = useStore((s) => s.appQuestions)
  const asking = useMemo(
    // The questions are this computer's own: another machine's user-folder app of the same id never matches one (`sameApp` reads the machine)
    () => questions.find((q) => sameApp(q.origin, pv)) ?? null,
    [questions, pv],
  )

  // The view's `ui/message` (B-4) waits while MessageAsk asks which session (useMessageAsk); nothing goes before the pick
  const sendViewMessage = useStore((s) => s.sendViewMessage)
  const { ask, onMessage, take, settle: settleAsk } = useMessageAsk()
  const answer = async (sessionId: string | null) => {
    if (!sessionId) return void settleAsk(false)
    const a = take()
    if (!a) return
    // As an in-conversation view sends (`apps.viewMessage`): the host wraps it as the app's text. Sent as the person's
    // (`send`), the app's text would pose as the person's instruction.
    const sent = pv.instanceId ? await sendViewMessage(sessionId, pv.instanceId, a.text) : false
    if (sent) setToast(`Sent to ${useStore.getState().sessions[sessionId]?.name ?? 'the session'}`)
    a.resolve(sent)
  }
  // A view going down (closed, restarted, untrusted) declines a pending ask: nothing is left to answer it
  useEffect(() => {
    if (pv.phase !== 'open') settleAsk(false)
  }, [pv.phase, settleAsk])

  // For the store (C-4): reopening on new code (reloadPinnedView) sends teardown through this handle first
  useEffect(() => {
    if (pv.phase !== 'open' || !pv.instanceId) return
    return registerPinnedFrame(pv.key, { teardown: () => frame.current?.teardown() ?? Promise.resolve('not-connected') })
  }, [pv.phase, pv.instanceId, pv.key])
  const reload = useStore((s) => s.reloadPinnedView)
  const setAppShared = useStore((s) => s.setAppShared)

  const canOpen = !!app && !!app.info.home && app.status.runnable
  useEffect(() => {
    if (canOpen && pv.phase === 'idle') void start(pv.key)
  }, [canOpen, pv.phase, pv.key, start])

  // The app can no longer run (`viewMustClose`), and its view is that project's code too, so it comes down. The slot
  // stays, idle, and reopens once the app can run.
  const blocked = !!app && viewMustClose(app.info)
  useEffect(() => {
    if (!blocked || pv.phase !== 'open') return
    let alive = true
    void (async () => {
      await frame.current?.teardown()
      if (alive) release(pv.key)
    })()
    return () => {
      alive = false
    }
  }, [blocked, pv.phase, pv.key, release])

  // Gone only once seen: the empty moment between list reads would otherwise close a fine view
  const seen = useRef(false)
  if (app) seen.current = true
  const gone = seen.current && !app
  useEffect(() => {
    if (!gone) return
    void (async () => {
      await frame.current?.teardown()
      close(pv.key)
      setToast(`${pv.appId} is no longer available — its folder or project was removed`)
    })()
  }, [gone, pv.key, pv.appId, close, setToast])

  // Back on its project's screen it is a panel and keeps this view (#203), so × only leaves; elsewhere it goes down
  const toPanel = useStore((s) => returnsToPanel(s, pv.key))
  const leave = useStore((s) => s.leavePinnedView)
  const onClose = async () => {
    if (leave(pv.key)) return
    await frame.current?.teardown()
    close(pv.key)
  }
  // Restarting is also a way the view goes down — teardown is sent first
  const restart = useStore((s) => s.restartApp)
  const onRestart = async () => {
    await frame.current?.teardown()
    await restart(pv.key)
  }
  // Stops an app kept running for background work (#1236); its view goes too, or it would hold the app
  const stop = useStore((s) => s.stopApp)
  const onStop = async () => {
    await frame.current?.teardown()
    await stop({ key: pv.key, appId: pv.appId, projectId: pv.projectId, machine: pv.machine })
  }
  const busy = app?.info.status === 'running' ? (app.info.busy ?? null) : null

  return (
    <section
      ref={section}
      className={
        mode === 'full'
          ? 'flex min-h-0 min-w-0 flex-1 flex-col'
          : mode === 'slot'
            ? // The slot is the panel's body: the panel's ground under it, and its rounded bottom corners inside the 1px border
              'absolute flex min-h-0 min-w-0 flex-col overflow-hidden rounded-b-[calc(var(--radius-lg)-1px)] bg-surface-floor'
            : OUT_OF_SIGHT
      }
      inert={mode === 'hidden'}
      data-testid={`pinned-app-${pv.key}`}
      data-phase={pv.phase}
      data-mode={mode}
      aria-label={app?.title ?? pv.appId}
    >
      {/* The panel on the project screen has its own header; this one's buttons open panels a slot has no room for */}
      {visible && (
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-ink-muted">
            <AppIcon />
          </span>
          <span className="truncate text-md font-medium tracking-tight text-ink" data-testid="pinned-title">
            {app?.title ?? pv.appId}
          </span>
          <span className="truncate text-xs text-ink-faint">{scope}</span>
          {app && (
            <span className="readout shrink-0 text-2xs text-ink-faint" data-testid="pinned-status">
              {app.status.label}
            </span>
          )}
          {busy && (
            <>
              <span className="min-w-0 truncate text-2xs text-ink-faint" data-testid="pinned-busy" title={`Running: ${busy}`}>
                Running: {busy}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
                onClick={() => void onStop()}
                title="The app keeps itself running for this work while nothing is open. Stop it and close this view; it starts again the next time something needs it"
                data-testid="pinned-stop"
              >
                Stop
              </button>
            </>
          )}
          {/* Reopened with new code (C-4): a brief note. Changed too often to reopen alone: the person reloads */}
          {pv.phase === 'open' && pv.updatedAt && <UpdatedCue key={pv.updatedAt} at={pv.updatedAt} testId="pinned-updated" />}
          {pv.phase === 'open' && pv.stale && (
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
              onClick={() => void reload(pv.key)}
              title="The app now runs new code. It changed several times in a row, so this view was not reopened on its own"
              data-testid="pinned-stale"
            >
              Changed · Reload
            </button>
          )}
          {builder.id && (
            <button
              type="button"
              className={`ml-auto rounded-md px-2 py-0.5 text-xs transition-colors ${
                builderOpen ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:bg-surface-hover/50 hover:text-ink'
              }`}
              aria-pressed={builderOpen}
              onClick={() => setBuilderOpen((v) => !v)}
              data-testid="pinned-builder-toggle"
              title="The builder session's conversation, beside this app"
            >
              Builder
            </button>
          )}
          <button
            type="button"
            className={`${builder.id ? '' : 'ml-auto '}rounded-md px-2 py-0.5 text-xs transition-colors ${
              runsOpen ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:bg-surface-hover/50 hover:text-ink'
            }`}
            aria-pressed={runsOpen}
            onClick={() => setRunsOpen((v) => !v)}
            data-testid="pinned-runs-toggle"
            title="Recent runs of this app — who called which tool, and how it ended"
          >
            Runs
          </button>
          {!!app?.info.secrets?.length && (
            <button
              type="button"
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                secretsOpen ? 'bg-surface-hover text-ink' : `${missing ? 'text-ink' : 'text-ink-faint'} hover:bg-surface-hover/50 hover:text-ink`
              }`}
              aria-pressed={secretsOpen}
              onClick={() => setSecretsOpen((v) => !v)}
              data-testid="pinned-secrets-toggle"
              title="The secrets this app declares — which are set, and a place to set them"
            >
              {missing ? `Secrets · ${missing} missing` : 'Secrets'}
            </button>
          )}
          {/* Sharing with other projects (#371 part A), as in Settings → Apps. Not for a root app: its project's trust decides (#1141) */}
          {app?.projectId && !app.info.root && (
            <button
              type="button"
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                app.info.shared ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:bg-surface-hover/50 hover:text-ink'
              }`}
              aria-pressed={app.info.shared === true}
              onClick={() => void setAppShared(app.projectId!, app.appId, !app.info.shared)}
              data-testid="pinned-share-toggle"
              title={
                app.info.shared
                  ? 'Shared with your other projects: their sessions can attach it while they need it. Press to stop sharing'
                  : 'Share with your other projects: their sessions could attach it while they need it, after you allow each project once'
              }
            >
              {app.info.shared ? 'Shared' : 'Share'}
            </button>
          )}
          {app && (
            <button
              type="button"
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                versionsOpen ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:bg-surface-hover/50 hover:text-ink'
              }`}
              aria-pressed={versionsOpen}
              onClick={() => setVersionsOpen((v) => !v)}
              data-testid="pinned-versions-toggle"
              title={app.projectId ? 'Commits that touched this app (git keeps its versions)' : 'Earlier versions of this app, and a way back to them'}
            >
              Versions
            </button>
          )}
          <button
            type="button"
            className="flex items-center justify-center rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
            aria-label={toPanel ? `Back to ${scope}, where ${app?.title ?? pv.appId} stays in its panel` : `Close ${app?.title ?? pv.appId}`}
            onClick={() => void onClose()}
            data-testid="pinned-close"
          >
            <CloseIcon />
          </button>
        </header>
      )}
      {/* The view's box is always this row's first child,
          so a side panel never makes React recreate it (PinnedApps) */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2">
          <Body app={app} pv={pv} frame={frame} onRestart={() => void onRestart()} onMessage={onMessage} />
          <ErrorTail app={app} builder={builder} onShowBuilder={showBuilder} onShowRuns={showRuns} />
          <FixBar app={app} pv={pv} builder={builder} onShowBuilder={showBuilder} />
          {ask && <MessageAsk appTitle={app?.title ?? pv.appId} projectId={pv.projectId} ask={ask} onAnswer={(id) => void answer(id)} />}
          {asking && <CapabilityAsk question={asking} visible={mode !== 'hidden'} />}
        </div>
        {/* Drawn only while visible — if the focus view drew the same session while this is hidden, one conversation would stand in two panels */}
        {builderOpen && visible && builder.id && <BuilderPane sessionId={builder.id} onClose={() => setBuilderOpen(false)} />}
        {visible && runsOpen && <RunsPanel appId={pv.appId} projectId={pv.projectId} machine={pv.machine} />}
        {visible && secretsOpen && app && <SecretsPanel app={app} />}
        {visible && versionsOpen && app && <VersionsPanel app={app} />}
      </div>
      {/* The panel's drag cover, through a portal (dragShield.tsx);
          no box of its own, it lies against this section */}
      {mode === 'slot' && <div ref={shieldHost} className="contents" data-testid="app-drag-shield-host" />}
    </section>
  )
}

function Body({
  app,
  pv,
  frame,
  onRestart,
  onMessage,
}: {
  app: ExternalCatalogApp | undefined
  pv: PinnedView
  frame: React.RefObject<AppFrameHandle | null>
  onRestart: () => void
  onMessage: (m: AppFrameMessage) => Promise<boolean>
}) {
  const connection = useStore((s) => s.connection)
  const title = app?.title ?? pv.appId
  // While open, the frame is always drawn: a notice swapped in first would detach it before the effects above send
  // teardown (AppFrame's contract). A died app (B-6) gets its reason and Restart above the frame, which stays: a
  // crashed app comes back on the next call, a failed one only through Restart.
  if (pv.phase === 'open' && pv.instanceId) {
    const down = app?.info.status === 'crashed' || app?.info.status === 'failed'
    return (
      <>
        {down && (
          <div
            className="mb-2 flex items-start gap-3 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm"
            role="alert"
            data-testid="pinned-crashed"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ink">{app?.info.status === 'failed' ? 'This app stopped after failing repeatedly.' : 'This app stopped.'}</p>
              {app?.status.reason && (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-muted" data-testid="pinned-reason">
                  {app.status.reason}
                </p>
              )}
            </div>
            <RestartButton onClick={onRestart} />
          </div>
        )}
        <AppFrame
          ref={frame}
          fill
          appId={pv.appId}
          projectId={pv.projectId}
          machine={pv.machine}
          instanceId={pv.instanceId}
          toolInput={pv.toolInput}
          toolResult={pv.toolResult}
          onMessage={onMessage}
          loading={<Skeleton label={`Opening ${title}…`} />}
          className="flex min-h-0 flex-1 flex-col"
        />
      </>
    )
  }
  if (!app) return null
  // An import awaiting confirmation (M4 E-3), first whether or not it has a view; enabling opens it right here
  if (app.info.status === 'unconfirmed') return <ReviewAndEnable app={app} />
  if (!app.info.home) {
    return (
      <Notice testId="pinned-no-screen" title="This app has no screen.">
        {app.info.description ?? 'Its manifest names no home tool, so there is nothing to show here.'}
      </Notice>
    )
  }
  if (app.info.status === 'untrusted') {
    return (
      <Notice testId="pinned-untrusted" title={app.status.reason ?? ''}>
        Trusting lets this project&apos;s apps run and its settings apply.
        {app.projectId && (
          // The same card as the project's row, with its apps listed (#1141): trusting is never one press away
          <TrustProjectButton projectId={app.projectId} testId="pinned-trust" className="mt-3 block" />
        )}
      </Notice>
    )
  }
  // Failed to start repeatedly: it does not come back on its own, so the reason comes with Restart
  if (app.info.status === 'failed') {
    return (
      <Notice testId="pinned-failed" title="This app stopped after failing repeatedly.">
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {app.status.reason}
        </span>
        <RestartButton onClick={onRestart} className="mt-3" />
      </Notice>
    )
  }
  if (!app.status.runnable) {
    return (
      <Notice testId="pinned-blocked" title={app.status.label}>
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {app.status.reason}
        </span>
      </Notice>
    )
  }
  if (pv.phase === 'failed') {
    return (
      <Notice testId="pinned-open-failed" title="This app's screen could not be opened.">
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {pv.error}
        </span>
        <RestartButton onClick={onRestart} className="mt-3" />
      </Notice>
    )
  }
  const label =
    pv.phase === 'opening' && connection !== 'connected' ? 'Reconnecting…' : pv.phase === 'restarting' ? `Restarting ${title}…` : app.info.status === 'running' ? `Opening ${title}…` : `Starting ${title}…`
  return <Skeleton label={label} />
}

function RestartButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <Button variant="primary" onRaised className={`shrink-0 ${className}`} onClick={onClick} data-testid="pinned-restart">
      Restart
    </Button>
  )
}

/**
 * The placeholder while an app starts (B-6), on first need (budget: the skeleton at once, the first screen within 2 s).
 * The view's shape and one line of what it waits for, as a bare "Loading" reads as stalled. Quiet colors: waiting
 * calls no one (the palette rule).
 */
function Skeleton({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
      role="status"
      aria-live="polite"
      data-testid="pinned-skeleton"
    >
      <p className="text-sm text-ink-muted" data-testid="pinned-skeleton-label">
        {label}
      </p>
      <div className="h-3 w-1/3 animate-pulse rounded-md bg-surface-hover/60" />
      <div className="h-24 animate-pulse rounded-md bg-surface-hover/40" />
      <div className="h-3 w-2/3 animate-pulse rounded-md bg-surface-hover/40" />
      <div className="h-3 w-1/2 animate-pulse rounded-md bg-surface-hover/40" />
    </div>
  )
}

function Notice({ testId, title, children }: { testId: string; title: string; children?: ReactNode }) {
  return (
    <div className="m-auto max-w-md px-6 py-10 text-center" data-testid={testId}>
      <p className="text-md text-ink">{title}</p>
      {children && <div className="mt-2 flex flex-col items-center text-sm leading-body text-ink-muted">{children}</div>}
    </div>
  )
}
