import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { externalAppKey, gridScreenAppKeys, projectScreenAppKeys, registerPinnedFrame, returnsToPanel, useStore, type PinnedView } from '../../store/store.js'
import { useExternalApp, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { RunsPanel } from './RunsPanel.jsx'
import { MessageAsk, messageText, type MessageAskState } from './MessageAsk.jsx'
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
 * Where a pinned view is drawn.
 *   full    the app view — the main area is this app
 *   slot    laid over its panel on the project screen (#203) or the grid (#288, slots.ts) — the frame and what stands on it, no header
 *   hidden  alive and out of sight
 */
type Mode = 'full' | 'slot' | 'hidden'

/**
 * How a hidden view is put out of sight: moved past the window's left edge at the lane's size, and
 * `inert`, so neither the keyboard, the pointer nor assistive tech reaches it.
 *
 * Never `display: none` or `visibility: hidden`, on the view or on anything around it. In WKWebView
 * (the desktop app) a frame hidden either way and shown again stops drawing the native scrollbars
 * of the scrolling areas inside the app's document: the gutter keeps its width, nothing is drawn in
 * it, and scrolling the area from script does not bring it back (#309). Measured with the system
 * WebKit of macOS 27, legacy (always shown) scrollbars, a frame nested the way a view's is: both
 * ways lost them; `opacity: 0`, and moving the frame out of the window and back, kept them. The
 * grid, the project screen and the app view all hide views here, so going to a session and back
 * left a board app on the grid with empty gutters, and so did dragging a panel while #294 hid every
 * view for the length of a drag. Overlay scrollbars (a trackpad's default) take no gutter, and
 * Playwright's WebKit forces them, which is why this never showed in e2e.
 *
 * `-200vw`: the lane starts at the sidebar's edge and is narrower than the window, so the whole box
 * lies left of the window's edge. A negative offset adds nothing anyone can scroll to.
 */
const OUT_OF_SIGHT = 'absolute inset-y-0 -left-[200vw] flex w-full min-h-0 min-w-0 flex-col'

/**
 * The pinned view (M4 B-2) — an app opened from the sidebar takes over the main area.
 *
 * **Every open view stays mounted.** Only one is visible; the rest are moved out of the window
 * (`OUT_OF_SIGHT`). Going to look at a session and coming back is still the same iframe, the same
 * document, the same instance. The spec's statement that a view holds no state means "it reads fresh
 * when it comes back up," not that it is fine to remount it. Remounting would drop whatever field was
 * being typed in, whatever list was expanded, and the scroll position, and the app would receive
 * `home` all over again. An iframe discards its document the moment it is detached from the DOM (even
 * just moving it causes a fresh read), while merely hiding it keeps the document alive. So this layer
 * is always rendered in App's center lane as **a child that never changes position.**
 *
 * There are exactly three paths down, and all three send the spec's teardown first (AppFrame's
 * contract: called before detaching).
 *   close                    the person pressed ×
 *   the app has disappeared  its folder was deleted, its project was deleted
 *   the app can no longer run  it lost trust, its manifest broke — the view's HTML is also that
 *                              project's code
 */
export function PinnedApps() {
  const pinned = useStore((s) => s.pinnedViews)
  const showing = useStore((s) => s.view === 'app')
  const focusedKey = useStore((s) => (s.focusedApp ? externalAppKey(s.focusedApp.projectId, s.focusedApp.appId) : null))
  /*
   * The views laid over panels: the project screen's apps, or the grid's (#288). Only one of the two screens shows at a
   * time, so at most one of these lists is not empty. Joined into one string: a selector that returns a new array on
   * every call never settles
   */
  const slotted = useStore((s) => [...projectScreenAppKeys(s), ...gridScreenAppKeys(s)].join('\n'))
  const slots = new Set(slotted ? slotted.split('\n') : [])
  const modeOf = (key: string): Mode => (showing ? (key === focusedKey ? 'full' : 'hidden') : slots.has(key) ? 'slot' : 'hidden')
  return (
    /*
      Anywhere but the app view this layer takes no room of its own (`contents`): its slotted views are
      absolutely placed in the middle lane, over their panels, and its hidden ones out of the window.
      Never `hidden` (display: none), even with no view in sight — that would hide every frame in it
      the way OUT_OF_SIGHT says it must not be. Only the class changes, never the parent, so no frame
      is ever taken out of the document.
    */
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
  const app = useExternalApp(pv.projectId, pv.appId)
  const frame = useRef<AppFrameHandle>(null)
  const start = useStore((s) => s.startPinnedView)
  const release = useStore((s) => s.releasePinnedView)
  const close = useStore((s) => s.closeApp)
  const setToast = useStore((s) => s.setToast)
  const scope = useStore((s) => (pv.projectId ? (s.projects[pv.projectId]?.name ?? 'Project') : 'Your apps'))
  // The Runs panel (B-7) opens independently per view — a person watching one app's runs moving to another app sees that app's own panel state first
  const [runsOpen, setRunsOpen] = useState(false)
  // The Secrets panel (M4 E) — only exists for an app that declares secrets. If any are unset, the header's button states the count
  const [secretsOpen, setSecretsOpen] = useState(false)
  // The Versions panel (M4 E-1) — a snapshot history and a way back for a user-folder app; git's own commits (read-only) for a project app
  const [versionsOpen, setVersionsOpen] = useState(false)
  const missing = missingSecrets(app)
  // The builder session (C-5) — the input row below sends into it, and its conversation opens and closes beside the view (BuilderPane)
  const builder = useAppBuilder(pv.projectId, pv.appId)
  const [builderOpen, setBuilderOpen] = useState(false)
  // A builder session's conversation opened beside it is a session that is on screen — its turn ending is a breeze, not a card (`isOnScreen`)
  const setBuilderPane = useStore((s) => s.setBuilderPane)
  const paneSession = builderOpen && visible && builder.id ? builder.id : null
  useEffect(() => {
    if (!paneSession) return
    setBuilderPane(paneSession)
    return () => {
      if (useStore.getState().builderPaneSessionId === paneSession) setBuilderPane(null)
    }
  }, [paneSession, setBuilderPane])
  /*
   * "Show the conversation" (FixBar, ErrorTail). In the app view the pane opens beside the view. A view laid over a
   * panel — the grid's or the project screen's — draws no pane (`visible` is false there: a panel is too narrow for a
   * 380px conversation beside the app), so the link goes to the app view with the pane open, through `openApp`, the
   * door the panel's Open uses. On the project screen that is this same view; on the grid it is the app's own view,
   * apart from the grid's (#288). Setting only this view's flag in a slot did nothing a person could see.
   */
  const openApp = useStore((s) => s.openApp)
  const showBuilder = () => {
    if (visible) setBuilderOpen(true)
    else openApp(pv.projectId, pv.appId, { builder: true })
  }
  const paneAsked = useStore((s) => s.builderPaneFor === pv.key)
  const takePaneAsk = useStore((s) => s.takeBuilderPaneFor)
  useEffect(() => {
    if (!paneAsked || !visible) return
    setBuilderOpen(true)
    takePaneAsk(pv.key)
  }, [paneAsked, visible, pv.key, takePaneAsk])
  /*
   * A capability question from a chain started by this app's view (M4 D-4) — one at a time, oldest
   * first. The whole list is selected and filtered here: if the selector itself returned a new
   * array every time, it would read as a new value on every store change.
   */
  const questions = useStore((s) => s.appQuestions)
  const asking = useMemo(
    () => questions.find((q) => q.origin.appId === pv.appId && (q.origin.projectId ?? null) === (pv.projectId ?? null)) ?? null,
    [questions, pv.appId, pv.projectId],
  )

  /*
   * The view's `ui/message` (B-4) — asks which session to send it to (MessageAsk). Nothing is sent
   * before the person chooses, and the view's request waits for an answer. If an earlier question is
   * still pending, it is closed as declined (the same rule as link confirmation, AppFrame). A
   * message with not a single piece of text is declined without asking — there is nothing to send.
   */
  const sendViewMessage = useStore((s) => s.sendViewMessage)
  const [ask, setAsk] = useState<MessageAskState | null>(null)
  const askRef = useRef<MessageAskState | null>(null)
  const settleAsk = useCallback((sent: boolean) => {
    const a = askRef.current
    askRef.current = null
    setAsk(null)
    a?.resolve(sent)
    return a
  }, [])
  const onMessage = useCallback(
    (m: AppFrameMessage) =>
      new Promise<boolean>((resolve) => {
        const { text, dropped } = messageText(m.content)
        if (!text) return resolve(false)
        askRef.current?.resolve(false)
        const next = { text, dropped, resolve }
        askRef.current = next
        setAsk(next)
      }),
    [],
  )
  const answer = async (sessionId: string | null) => {
    if (!sessionId) return void settleAsk(false)
    const a = askRef.current
    if (!a) return
    askRef.current = null
    setAsk(null)
    /*
     * Sent through **the same path** as an in-conversation view (`apps.viewMessage`) — it lands in
     * the chosen conversation as a message from the app, and the agent receives it wrapped by the
     * host as "the app's text." Sending it as the person's own message (`send`) would disguise the
     * app's text as the person's own instruction. The host builds the frame around it.
     */
    const sent = pv.instanceId ? await sendViewMessage(sessionId, pv.instanceId, a.text) : false
    if (sent) setToast(`Sent to ${useStore.getState().sessions[sessionId]?.name ?? 'the session'}`)
    a.resolve(sent)
  }
  // When the view goes down (closed, restarted, loses trust), a pending question closes as declined too — there is no view left to answer it
  useEffect(() => {
    if (pv.phase !== 'open') settleAsk(false)
  }, [pv.phase, settleAsk])
  useEffect(() => () => void settleAsk(false), [settleAsk])

  /*
   * Registers the rendered frame with the store (C-4) — when the app comes back up with new code,
   * the store reopens this view (reloadPinnedView), but sends teardown through this handle first.
   */
  useEffect(() => {
    if (pv.phase !== 'open' || !pv.instanceId) return
    return registerPinnedFrame(pv.key, { teardown: () => frame.current?.teardown() ?? Promise.resolve('not-connected') })
  }, [pv.phase, pv.instanceId, pv.key])
  const reload = useStore((s) => s.reloadPinnedView)

  const canOpen = !!app && !!app.info.home && app.status.runnable
  useEffect(() => {
    if (canOpen && pv.phase === 'idle') void start(pv.key)
  }, [canOpen, pv.phase, pv.key, start])

  /*
   * Trust was lost, or the manifest broke — the app can no longer run. The view (the app's own HTML)
   * is also that project's code, so it comes down along with it. The slot is kept and returned to
   * idle: trusting it again reopens it in this same slot.
   */
  // The same applies when an imported app is waiting to be reconfirmed (M4 E-3) — if what runs after enabling it changed, the view's HTML is also code the person has not yet reviewed
  const blocked = app?.info.status === 'untrusted' || app?.info.status === 'invalid' || app?.info.status === 'unconfirmed'
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

  /*
   * The app has disappeared. **Only an app seen at least once** is treated as having disappeared —
   * reading the empty moment between re-reads of the list as a disappearance would close a perfectly
   * fine view.
   */
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

  /*
   * Back to its project's screen, the app is a panel there and keeps this view (#203) — × only leaves. Anywhere else
   * nothing shows the view any more, so it goes down, teardown first.
   */
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
          {/* Reopened with new code (C-4) — a brief note that appears momentarily. If it changed too often to reopen on its own, the person presses it */}
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
      {/*
        The view's own box is always this row's first child. Opening and closing a side panel never
        makes React recreate that box — recreating it would detach the iframe and lose the document
        (see this file's header comment).
      */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2">
          <Body app={app} pv={pv} frame={frame} onRestart={() => void onRestart()} onMessage={onMessage} />
          <ErrorTail app={app} builder={builder} onShowBuilder={showBuilder} onShowRuns={() => setRunsOpen(true)} />
          <FixBar app={app} pv={pv} builder={builder} onShowBuilder={showBuilder} />
          {ask && <MessageAsk appTitle={app?.title ?? pv.appId} projectId={pv.projectId} ask={ask} onAnswer={(id) => void answer(id)} />}
          {asking && <CapabilityAsk question={asking} visible={mode !== 'hidden'} />}
        </div>
        {/* Drawn only while visible — if the focus view drew the same session while this is hidden, one conversation would stand in two panels */}
        {builderOpen && visible && builder.id && <BuilderPane sessionId={builder.id} onClose={() => setBuilderOpen(false)} />}
        {visible && runsOpen && <RunsPanel appId={pv.appId} projectId={pv.projectId} />}
        {visible && secretsOpen && app && <SecretsPanel app={app} />}
        {visible && versionsOpen && app && <VersionsPanel app={app} />}
      </div>
      {/*
        The panel's drag cover goes in here, through a portal from the panel (dragShield.tsx). No box of its own: the
        cover is placed against this section, over the frame and everything else in it.
      */}
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
  const trust = useStore((s) => s.setProjectTrusted)
  const title = app?.title ?? pv.appId
  /*
   * While the instance is open, the frame is drawn **no matter what.** If the app gets blocked or
   * disappears, the effect above sends teardown and reverts the slot. Swapping in a notice here
   * before that would make React detach the iframe first, leaving no window left for teardown to
   * reach (AppFrame's contract: called before detaching).
   *
   * If a running app died (B-6), the reason and a "Restart" button are placed on top of the frame.
   * The frame itself stays: the app comes back up on its own on the next call (crashed), and whatever
   * was on screen is still there. A stopped app (failed) does not come back up on its own, so this
   * button is the only way.
   */
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
  // An imported app waiting for the person's confirmation (M4 E-3) — confirmation comes first whether or not it has a view. Enabling it opens the app right here
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
          <button
            type="button"
            className="mt-3 block rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong"
            onClick={() => void trust(app.projectId!, true)}
            data-testid="pinned-trust"
          >
            Trust this project
          </button>
        )}
      </Notice>
    )
  }
  // A stopped app (failed to start repeatedly) — it does not come back up on its own. The reason and a way to restart are given together
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
    pv.phase === 'restarting' ? `Restarting ${title}…` : app.info.status === 'running' ? `Opening ${title}…` : `Starting ${title}…`
  return <Skeleton label={label} />
}

function RestartButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`shrink-0 rounded-md border border-line bg-surface-floor px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong ${className}`}
      onClick={onClick}
      data-testid="pinned-restart"
    >
      Restart
    </button>
  )
}

/**
 * The placeholder while an app is starting up (B-6). Decision, 2026-09-14: doing the skeleton well
 * is all the async case needs.
 *
 * An app starts up on first need, so opening a previously idle app is exactly the moment its process
 * starts (performance budget: the skeleton appears instantly, the first screen within 2 seconds). An
 * empty area or a bare one-line "Loading" is indistinguishable from something stalled. The shape of
 * where the view will stand is shown first, and what it is waiting for is stated in one line
 * (starting up, opening, or restarting). Only quiet colors are used — waiting is not a signal meant
 * to call the person (the palette rule).
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
