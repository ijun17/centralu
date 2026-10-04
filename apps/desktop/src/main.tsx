import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { App, applyCachedTheme, confirmKeyAction } from '@cc/ui'
import {
  createTauriPlatform,
  focusWindow,
  hostBuild,
  listenForQuit,
  onHostBuild,
  quitAndStopAgents,
  restartHost,
  swapProgressText,
  swapRunning,
  switchHostBuild,
  switchPlan,
  type HostBuild,
  type HostStatus,
} from '@cc/platform/tauri'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import '../../../packages/ui/src/styles/index.css'

/**
 * The desktop entry point — one of the two places that knows about a concrete implementation
 * (docs/platform-abstraction.md §4). The only difference from apps/web is the single
 * createTauriPlatform line.
 */
// The theme the last run chose, before anything is drawn — even the waiting-for-host screen
// should open in it, and the preferences only arrive once the host answers (theme.ts)
applyCachedTheme()

const root = createRoot(document.getElementById('root')!)

// A quit request is listened for **before anything else** (#184). Neither the screen waiting
// on the host nor the launch-failure screen has a modal to ask the question, so it just quits
// right away; once the app screen is up, that modal takes over asking.
const setQuitAsker = listenForQuit()

boot()

function boot() {
  // **Draw something first.** If nothing is rendered while waiting on the host, an empty black
  // window shows up, and that reads as broken (flagged during dogfooding).
  root.render(<Starting />)
  createTauriPlatform()
    .then(async (platform) => {
      root.render(<DesktopRoot platform={platform} />)
      await registerGlobalShortcut()
    })
    .catch((err: Error) => root.render(<StartupFailure message={err.message} onRetry={retry} />))
}

/**
 * Retry on the failure screen (#184). This used to be `location.reload()`, which only
 * reloaded the webview, and a supervisor that had already given up did not restart, so the
 * same message reappeared 30 seconds later. This restarts the supervisor and waits again as
 * if from the start.
 */
function retry() {
  root.render(<Starting />)
  void restartHost()
    .catch(() => false)
    .then(boot)
}

/**
 * Prevents ⌘Q and ⌘W from quitting immediately (dogfooding, 2026-09-04) — lives here because
 * it is a desktop-only concern.
 *
 * Rust intercepts every path toward quitting (the menu's Quit, ⌘Q, closing the window) and
 * fires `quit-requested`, and this modal does the asking. Only "Quit" calls quit_app to open
 * the gate — in an app where a single typo can take down every running session, quitting has
 * to be two actions.
 * The web build (apps/web) has no such path at all: closing a browser tab is the browser's own
 * business.
 */
function DesktopRoot({ platform }: { platform: ComponentProps<typeof App>['platform'] }) {
  const [askQuit, setAskQuit] = useState(false)
  /**
   * Leftover processes still running from our project folders (requested by the person,
   * 2026-09-07).
   *
   * A dev server an agent launched via bash is not caught by our shutdown procedure — measured
   * directly, that process has ppid=1 and is its own process group, so both the parent chain
   * and the group are disconnected from ours. So instead of killing it, **it is shown here.**
   * The quit modal is already the place that reads "do you really want to shut down", and
   * there is no better place for the fact that something is left running to land.
   *
   * **Off by default.** Something a person launched directly in the same folder can also end
   * up in this list, and silently killing it while trying to clean up an orphan would cut off
   * someone else's work. Since the list is right there, one click cleans it up together — the
   * person is the one who chooses.
   */
  const [strays, setStrays] = useState<{ pid: number; command: string; cwd: string }[]>([])
  const [alsoStop, setAlsoStop] = useState(false)
  /*
   * Background mode (#280), read each time the dialog opens: with it on, plain Quit leaves the
   * agents running, so the dialog says so and offers the one way to stop them anyway. Null while
   * unknown or where the platform has no keeper — then the dialog reads as it always did.
   */
  const [background, setBackground] = useState<boolean | null>(null)
  const [quitError, setQuitError] = useState<string | null>(null)
  const quit = useCallback(
    async (stopAgents = false) => {
      if (alsoStop && strays.length > 0) {
        // A failure here does not block quitting — what the person clicked was "quit".
        await platform.processes.stop(strays.map((s) => s.pid)).catch(() => {})
      }
      if (stopAgents) {
        // If the keeper cannot be told, quitting anyway would leave agents running that the person
        // just asked to stop — so this one says why and stays open.
        await quitAndStopAgents().catch((e: Error) => setQuitError(e.message))
        return
      }
      await invoke('quit_app')
    },
    [alsoStop, strays, platform],
  )

  useEffect(() => {
    setQuitAsker(() => {
      setAskQuit(true)
      setAlsoStop(false)
      setQuitError(null)
      setBackground(null)
      void platform.background
        ?.get()
        .then(setBackground)
        .catch(() => setBackground(null))
      void platform.processes
        .strays()
        .then(setStrays)
        .catch(() => setStrays([]))
      // ⌘Q while minimized would leave the modal unseen, looking like "an app that will not
      // quit" — show the window whenever there is a question to ask.
      void focusWindow()
    })
    return () => setQuitAsker(null)
  }, [platform.processes, platform.background])

  /*
   * The case where the host gives up after exceeding its restart limit once the app is already
   * up (#184). This signal used to be received by nobody, so the top bar just stayed on
   * Connecting/Disconnected, and the reason the host gave was nowhere on screen. This puts the
   * same message and Retry as the launch-failure screen on top of the app, and clears it once
   * the host comes back up (ready) — switching to the new address is already handled by the
   * platform's onEndpointChange.
   */
  const [hostFailure, setHostFailure] = useState<string | null>(null)
  useEffect(() => {
    const un = listen<HostStatus>('host-status', (e) => {
      const p = e.payload
      if (typeof p !== 'object' || p === null) return
      if (p.state === 'failed') setHostFailure(p.message)
      else if (p.state === 'ready') setHostFailure(null)
    })
    return () => void un.then((f) => f())
  }, [])
  /*
   * A window of one build attached to a host of another (#280). Happens when the app was updated
   * or rebuilt while the keeper kept the old host running in the background. The window still
   * works against the old host; this bar says so and offers to switch.
   *
   * Switching is the keeper's blue-green swap (#280 step 3): the new build starts next to the
   * running host, which gets up to 10 seconds to finish the calls it serves itself, and the window
   * reconnects through the same front door. The bar shows each phase, and a failure with its
   * reason. It asks first only when something can be lost (`switchPlan`).
   *
   * The keeper itself moves to the window's build first (#280 step 4), handing everything over
   * without stopping anything. A keeper that is behind while the host is not gets the same bar.
   */
  const [build, setBuild] = useState<HostBuild | null>(null)
  const [askSwitch, setAskSwitch] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // A failed swap stays on the bar until dismissed; this remembers which one was
  const [dismissedSwap, setDismissedSwap] = useState<number | null>(null)
  useEffect(() => {
    void hostBuild()
      .then(setBuild)
      .catch(() => {})
    return onHostBuild((b) => {
      setBuild(b)
      if (b.sameBuild && b.keeperSameBuild !== false) setDismissed(false)
    })
  }, [])
  const keeper = build?.mode === 'keeper'
  const swap = keeper ? build?.swap : undefined
  const switching = swapRunning(swap)
  const swapFailed = swap?.phase === 'failed' && dismissedSwap !== swap.startedAt
  // Switched, but the keeper stayed on the previous build: worth a line, not an alarm
  const swapNotice = swap?.phase === 'done' && !!swap.keeperMessage && dismissedSwap !== swap.startedAt
  const otherBuild = keeper && (build?.sameBuild === false || build?.keeperSameBuild === false) && !dismissed
  const plan = build ? switchPlan(build) : null
  const startSwitch = () => {
    setSwitchError(null)
    void switchHostBuild().catch((e: Error) => setSwitchError(e.message))
  }

  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!askQuit) return
    /*
     * Moves focus to the dialog when it opens (#181). The dialog was not taking focus, so
     * focus stayed on the app underneath, and Tab passed through the elements below it first.
     * This traps focus inside the dialog and returns it to where it was once the dialog closes.
     */
    const before = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Intercepted at the capture phase so the app's other shortcuts do not fire while the
      // modal is open.
      if (e.key === 'Tab') {
        const box = dialogRef.current
        if (!box) return
        const stops = [...box.querySelectorAll<HTMLElement>('button, input')].filter((x) => !x.hasAttribute('disabled'))
        if (stops.length === 0) return
        const at = stops.indexOf(document.activeElement as HTMLElement)
        e.preventDefault()
        e.stopPropagation()
        const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length
        stops[next]!.focus()
        return
      }
      /*
       * Enter = quit, Esc = keep going — except for an in-progress IME composition and an
       * Enter pressed on a button (#181, `confirmKeyAction`). While Enter was read as quit
       * regardless of focus, pressing Enter after tabbing to Cancel also quit the app.
       */
      const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON'
      const action = confirmKeyAction({ key: e.key, isComposing: e.isComposing, onButton })
      if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation()
      if (action === 'cancel') setAskQuit(false)
      else if (action === 'confirm') void quit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (before && document.contains(before)) before.focus()
    }
  }, [askQuit, quit])
  return (
    <>
      <App platform={platform} />
      {hostFailure !== null && (
        <div className="fixed inset-0 z-40 bg-surface-floor/95" data-testid="host-failed">
          <StartupFailure
            message={hostFailure}
            title="The agent host stopped"
            onRetry={() => {
              setHostFailure(null)
              void restartHost().catch(() => false)
            }}
          />
        </div>
      )}
      {keeper && build && (switching || swapFailed || swapNotice || otherBuild) && (
        <div
          className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 border-b border-line bg-surface-side px-4 py-1.5 text-xs text-ink-muted"
          data-testid="host-other-build"
          role={swapFailed ? 'alert' : 'status'}
        >
          {switching || swapFailed || swapNotice ? (
            <span
              className={`min-w-0 flex-1 truncate ${swapFailed ? 'text-danger' : ''}`}
              title={swap?.message}
              data-testid="host-switch-progress"
            >
              {swapProgressText(swap)}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              {build.sameBuild === false
                ? `The agent host is running ${describeBuild(build.host)}.`
                : `The background keeper is running ${describeBuild(build.keeper)}.`}{' '}
              This window is {describeBuild(build.app)}.
            </span>
          )}
          {switchError && <span className="shrink-0 text-danger">{switchError}</span>}
          {!switching && otherBuild && (
            <button
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink hover:border-line-strong"
              onClick={() => {
                setSwitchError(null)
                if (swap) setDismissedSwap(swap.startedAt)
                // Ask only when something can be lost; otherwise just switch
                if (plan?.confirm) setAskSwitch(true)
                else startSwitch()
              }}
              data-testid="host-switch-build"
            >
              {swapFailed ? 'Try again' : 'Switch to this build'}
            </button>
          )}
          {!switching && (
            <button
              className="shrink-0 text-ink-faint hover:text-ink"
              onClick={() => {
                if (swap) setDismissedSwap(swap.startedAt)
                setDismissed(true)
              }}
            >
              {swapFailed || swapNotice ? 'Dismiss' : 'Not now'}
            </button>
          )}
        </div>
      )}
      {askSwitch && build && plan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin"
          data-testid="confirm-switch-build"
          onClick={() => setAskSwitch(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Switch the agent host to this build?"
            className="w-[380px] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-md text-ink">Switch the agent host to this window's build?</p>
            <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-switch-build-loses">
              {plan.loses}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink"
                onClick={() => setAskSwitch(false)}
              >
                Cancel
              </button>
              <button
                className={
                  build.keepsAgents
                    ? 'rounded-md border border-line px-3 py-1 text-sm text-ink hover:border-line-strong'
                    : 'rounded-md border border-danger/40 bg-danger-bg px-3 py-1 text-sm text-danger hover:border-danger/70'
                }
                data-testid="confirm-switch-build-yes"
                onClick={() => {
                  setAskSwitch(false)
                  startSwitch()
                }}
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
      {askQuit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin"
          data-testid="confirm-quit"
          onClick={() => setAskQuit(false)}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Quit Centralu?"
            className="w-[360px] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal) focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-md text-ink">Quit Centralu?</p>
            {background ? (
              <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-quit-background">
                Agents keep running in the background. Open Centralu again to come back to them,
                waiting approvals included.
              </p>
            ) : (
              <p className="mt-2 text-xs leading-body text-ink-muted">
                Running agent processes stop with the app. Conversations are saved and resume when
                you come back.
              </p>
            )}
            {quitError && <p className="mt-2 text-xs text-danger">{quitError}</p>}
            {strays.length > 0 && (
              <div className="mt-3 rounded-md border border-line bg-surface-floor p-2" data-testid="quit-strays">
                <p className="text-xs text-ink-muted">
                  {strays.length} process{strays.length > 1 ? 'es' : ''} started in your project
                  folders will keep running:
                </p>
                <ul className="mt-1 max-h-24 overflow-y-auto">
                  {strays.slice(0, 6).map((s) => (
                    <li key={s.pid} className="readout truncate text-2xs text-ink-faint" title={s.cwd}>
                      {s.pid} · {s.command}
                    </li>
                  ))}
                  {strays.length > 6 && (
                    <li className="text-2xs text-ink-faint">…and {strays.length - 6} more</li>
                  )}
                </ul>
                <label className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    className="accent-line-strong"
                    checked={alsoStop}
                    onChange={(e) => setAlsoStop(e.target.checked)}
                    data-testid="quit-stop-strays"
                  />
                  Stop them too
                </label>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink"
                onClick={() => setAskQuit(false)}
                data-testid="confirm-quit-no"
              >
                Cancel <span className="text-2xs text-ink-faint">esc</span>
              </button>
              {background && (
                <button
                  className="rounded-md border border-line px-2 py-1 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
                  onClick={() => void quit(true)}
                  data-testid="confirm-quit-stop"
                >
                  Quit and stop agents
                </button>
              )}
              <button
                className="rounded-md border border-danger/40 bg-danger-bg px-3 py-1 text-sm text-danger hover:border-danger/70"
                onClick={() => void quit()}
                data-testid="confirm-quit-yes"
              >
                Quit <span className="text-2xs">⏎</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** "build abc1234 (0.1.0-beta.6) from /Applications/Centralu.app" — what a person can check against what they installed */
function describeBuild(b: HostBuild['host']): string {
  if (!b) return 'an unknown build'
  const version = b.version ? ` (${b.version})` : ''
  const from = b.bundlePath ? ` from ${b.bundlePath}` : ''
  return `build ${b.commit}${version}${from}`
}

function Starting() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-surface-floor" data-testid="starting">
      <p className="text-md text-ink-muted">Starting the agent host…</p>
      {/* Not "macOS may ask": it is the OS that asks, and on Linux nothing asks at all.
          Naming one OS in a message every platform sees makes it read as a bug elsewhere. */}
      <p className="text-xs text-ink-faint">On first run, your system may ask for folder access.</p>
    </div>
  )
}

/** Shows what went wrong so the app does not sit on a blank screen when the host fails to come
 * up. */
function StartupFailure({
  message,
  onRetry,
  title = 'Could not start the agent host',
}: {
  message: string
  onRetry: () => void
  title?: string
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-surface-floor px-8 text-center">
      <p className="text-md text-ink">{title}</p>
      {/* The message from the sidecar spans multiple lines (what is missing, where it looked)
          — preserve the line breaks when showing it. */}
      <p className="max-w-md whitespace-pre-line font-mono text-xs leading-body text-ink-muted">{message}</p>
      <p className="max-w-md text-xs leading-body text-ink-faint">
        If restarting hits the same problem, check <span className="font-mono">~/.centralu/host.log</span>.
      </p>
      <button
        className="mt-1 rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink hover:border-line-strong"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  )
}

/**
 * A waiting session has to be reachable even while the app is in the background (FR-17, B-4).
 * Brings the window to the front and then runs the UI's own "go to next waiting" as-is.
 */
async function registerGlobalShortcut() {
  try {
    const { register, isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
    const accelerator = 'CommandOrControl+Shift+A'
    if (await isRegistered(accelerator)) return
    await register(accelerator, async (event) => {
      if (event.state !== 'Pressed') return
      await focusWindow()
      window.dispatchEvent(new CustomEvent('cc:next-waiting'))
    })
  } catch (e) {
    // The app must keep working normally even if the shortcut is already claimed by another
    // app.
    console.warn('Could not register the global shortcut', e)
  }
}
