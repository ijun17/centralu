import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, confirmKeyAction, prepareFirstPaint, useStore } from '@cc/ui'
import {
  autoSwitch,
  buildBar,
  createTauriPlatform,
  focusWindow,
  listenForQuit,
  onHostStatus,
  quitAndStopAgents,
  restartHost,
  restartKeeper,
  switchHostBuild,
  switchPlan,
  type ShellHostBuild,
  type TauriPlatform,
  watchHostBuild,
} from '@cc/platform/tauri'
import { invoke } from '@tauri-apps/api/core'
import { BuildBarView, RestartKeeperDialog, SwitchBuildDialog } from './build-bar.js'
import { QuitDialog } from './quit-dialog.js'
import '../../../packages/ui/src/styles/index.css'

/**
 * The desktop entry point — one of the two places that knows about a concrete implementation
 * (docs/platform-abstraction.md §4). The only difference from apps/web is the single
 * createTauriPlatform line.
 */
// The theme the last run chose, before anything is drawn — even the waiting-for-host screen
// should open in it, and the preferences only arrive once the host answers (theme.ts). The app
// itself is drawn once the bundled fonts are in, as in apps/web (firstPaint.ts says why); the
// waiting screen does not wait for them.
const firstPaint = prepareFirstPaint()

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
      await firstPaint
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
function DesktopRoot({ platform }: { platform: TauriPlatform }) {
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
  useEffect(
    () =>
      onHostStatus((p) => {
        if (p.state === 'failed') setHostFailure(p.message)
        else if (p.state === 'ready') setHostFailure(null)
      }),
    [],
  )
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
   *
   * A keeper that cannot move (a handoff that fails in an older keeper, #387) stays on its build
   * while the host swap goes ahead under it. Then the bar says this window runs its build and the
   * keeper moves when it next starts, and offers "Restart completely" rather than a switch that
   * would only fail again (`buildBar`, `keeperStaysBehind`).
   */
  const [build, setBuild] = useState<ShellHostBuild | null>(null)
  const [askSwitch, setAskSwitch] = useState(false)
  const [askRestart, setAskRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [switchError, setSwitchError] = useState<{
    message: string
    /** Present for a switch request, absent for a full restart failure. */
    afterSwap?: { startedAt?: number }
  } | null>(null)
  const [relaunchError, setRelaunchError] = useState<string | null>(platform.relaunchSwap.error ?? null)
  const [dismissed, setDismissed] = useState(false)
  // A failed swap stays on the bar until dismissed; this remembers which one was
  const [dismissedSwap, setDismissedSwap] = useState<number | null>(null)
  // The note that the keeper started without the permission shell, once dismissed, for this window's life
  const [dismissedShell, setDismissedShell] = useState(false)
  // Subscribed before asking, and a report that arrived first is not overwritten by the answer (`watchHostBuild`)
  useEffect(
    () =>
      watchHostBuild((b) => {
        setBuild(b)
        if (b.sameBuild && b.keeperSameBuild !== false) {
          setDismissed(false)
          // The keeper of this build answered: a full restart, if one ran, is over
          setRestarting(false)
        }
      }),
    [],
  )
  useEffect(() => {
    // A keeper carries its last swap across handoffs. Repeated reports of that old final
    // state cannot settle a new request which was refused or has not started a swap yet.
    const swap = build?.swap
    const final = swap && (swap.phase === 'done' || swap.phase === 'failed')
    if (build?.sameBuild || (final && swap.startedAt !== platform.relaunchSwap.previousSwapStartedAt)) {
      setRelaunchError(null)
    }
    // A request can time out even though its swap continues. The new outcome supersedes
    // that request error, including when the outcome arrived before the rejection.
    if (final && switchError?.afterSwap && swap.startedAt !== switchError.afterSwap.startedAt) {
      setSwitchError(null)
    }
  }, [build, platform.relaunchSwap.previousSwapStartedAt, switchError])
  const bar = build ? buildBar({ build, dismissed, dismissedSwap, dismissedShell }) : ({ kind: 'none' } as const)
  const plan = build ? switchPlan(build) : null
  const startSwitch = () => {
    setSwitchError(null)
    setRelaunchError(null)
    const afterSwap = { startedAt: build?.swap?.startedAt }
    void switchHostBuild().catch((e: Error) => setSwitchError({ message: e.message, afterSwap }))
  }
  /*
   * Applying an update by itself (#352). A window started by "Apply now" (the keeper held on
   * through the relaunch and said so: `build.relaunched`), or any window with "Apply updates
   * automatically when idle" on, switches the keeper and then the host to its build without a
   * click when nothing can be lost. When something can, the window "Apply now" started asks at
   * once, and the automatic mode waits for the next activity report that says idle. Once per
   * window: a failure stays on the bar with "Try again". Progress shows in the bar as for a click.
   * Forward only: a window whose build is not newer than the keeper's and the host's (an older
   * app opened from a backup, a build that cannot be ordered) never switches by itself.
   */
  const autoApply = useStore((s) => s.update?.autoApply ?? false)
  const autoTried = useRef(platform.relaunchSwap.tried)
  useEffect(() => {
    if (!build || build.mode !== 'keeper') return
    const next = autoSwitch({ build, autoApply, tried: autoTried.current, dismissed })
    if (next === 'switch') {
      autoTried.current = true
      setSwitchError(null)
      const afterSwap = { startedAt: build.swap?.startedAt }
      void switchHostBuild().catch((e: Error) => setSwitchError({ message: e.message, afterSwap }))
    } else if (next === 'ask') {
      autoTried.current = true
      setAskSwitch(true)
    }
  }, [build, autoApply, dismissed])

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
      const action = confirmKeyAction({ key: e.key, isComposing: e.isComposing, keyCode: e.keyCode, onButton })
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
  /*
   * Handed to App, which draws it between its top bar and the lanes (#326). Laid over the window
   * here (fixed, top 0) it covered the macOS traffic lights and the header's controls.
   */
  const buildBarNode =
    build && bar.kind !== 'none' ? (
      <BuildBarView
        build={build}
        bar={bar}
        error={switchError?.message ?? relaunchError}
        restarting={restarting}
        onSwitch={() => {
          setSwitchError(null)
          if (build.swap) setDismissedSwap(build.swap.startedAt)
          // Ask only when something can be lost; otherwise just switch
          if (plan?.confirm) setAskSwitch(true)
          else startSwitch()
        }}
        onDismiss={() => {
          if (bar.kind === 'shell') {
            setDismissedShell(true)
            return
          }
          if (build.swap) setDismissedSwap(build.swap.startedAt)
          setDismissed(true)
        }}
        onRestart={() => {
          setSwitchError(null)
          setAskRestart(true)
        }}
      />
    ) : null
  return (
    <>
      <App platform={platform} banner={buildBarNode} />
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
      {askSwitch && build && plan && (
        <SwitchBuildDialog
          loses={plan.loses}
          keepsAgents={build.keepsAgents}
          onCancel={() => setAskSwitch(false)}
          onConfirm={() => {
            setAskSwitch(false)
            startSwitch()
          }}
        />
      )}
      {askRestart && (
        <RestartKeeperDialog
          onCancel={() => setAskRestart(false)}
          onConfirm={() => {
            setAskRestart(false)
            setRestarting(true)
            void restartKeeper().catch((e: Error) => {
              setRestarting(false)
              setSwitchError({ message: e.message })
            })
          }}
        />
      )}
      {askQuit && (
        <QuitDialog
          background={background}
          strays={strays}
          alsoStop={alsoStop}
          error={quitError}
          dialogRef={dialogRef}
          onAlsoStop={setAlsoStop}
          onCancel={() => setAskQuit(false)}
          onQuit={(completely) => void quit(completely)}
        />
      )}
    </>
  )
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
