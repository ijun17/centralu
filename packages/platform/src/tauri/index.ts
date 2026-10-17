import { frameDragEndInPage } from '../engine.js'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AlertKind, Platform, RelaunchCheck, RelaunchPort, ShortcutKeys, SystemPort } from '../ports/index.js'
import type { HostBuild } from '@cc/protocol'
import { createWebPlatform } from '../web/index.js'
import { finishRelaunchSwap, type RelaunchSwapResult } from './relaunch-swap.js'
import { asError, rethrowAsError, toError } from './to-error.js'
import type { ShellStart, SwapView } from './switch-plan.js'

export {
  autoSwitch,
  buildBar,
  keeperStaysBehind,
  shellBarText,
  swapProgressText,
  swapRunning,
  switchPlan,
  type BuildBar,
  type ShellStart,
  type SwapView,
  type SwitchPlan,
} from './switch-plan.js'

/**
 * The Tauri implementation (docs/platform-abstraction.md §5, migration playbook steps 2-3).
 *
 * agents/projects **reuse the web implementation as-is** — both delegate to the host over the
 * same WS, so there is no new code to write. Tauri only does two things differently:
 *   1. Gets the host's port and token from the sidecar supervisor (the person never opens a
 *      terminal)
 *   2. The system port becomes real OS functionality (notifications, badge, opening the IDE)
 */

type HostInfo = { port: number; token: string }

type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; port: number; token: string }
  | { state: 'restarting'; attempt: number }
  | { state: 'failed'; message: string }

/**
 * Listens for the host's status, the shell's `host-status` report (#184). The one reader of that payload, for
 * the wait below, the endpoint switch and the desktop's failure screen (#850 item 17): anything that is not an
 * object with a state is dropped.
 * @returns a promise of the unsubscribe, settled once the listener is registered
 */
function listenHostStatus(cb: (status: HostStatus) => void): Promise<() => void> {
  return listen<unknown>('host-status', (e) => {
    const p = e.payload
    if (typeof p === 'object' && p !== null && typeof (p as { state?: unknown }).state === 'string') cb(p as HostStatus)
  })
}

/** `listenHostStatus` for a caller that does not wait on the registration */
export function onHostStatus(cb: (status: HostStatus) => void): () => void {
  const un = listenHostStatus(cb)
  return () => void un.then((f) => f()).catch(() => {})
}

/**
 * Waits for the sidecar to be ready. The app comes up before the host does.
 *
 * **Order matters:** subscribe to the event first, then ask for the current state.
 * Doing it the other way around can miss the signal if readiness finishes in between, and
 * stall all the way to the timeout (this actually happened once the host started coming up in
 * under a second). Polling is added on top as a third layer of defense.
 *
 * Polling also asks about **failure** (#184). The supervisor only leaves a failure message
 * when it gives up (a restart clears it), so if there is a message, that is the answer. It
 * used to be that missing the `failed` event — when a supervisor restarted by Retry gave up
 * again before the webview was listening — meant waiting out the full 30 seconds.
 */
async function waitForHost(timeoutMs = 30_000): Promise<HostInfo> {
  return new Promise<HostInfo>((resolve, reject) => {
    let done = false
    const stop = () => {
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      // Unsubscribes so subscriptions do not pile up on every retry
      void unlisten.then((f) => f()).catch(() => {})
    }
    const finish = (info: HostInfo) => {
      if (done) return
      stop()
      resolve(info)
    }
    const fail = (message: string) => {
      if (done) return
      stop()
      reject(new Error(message))
    }

    const timer = setTimeout(() => {
      void invoke<string | null>('host_error')
        .catch(() => null)
        .then((err) => fail(err ?? 'agent-host did not become ready in time'))
    }, timeoutMs)

    // (1) Subscribes first
    const unlisten = listenHostStatus((p) => {
      if (p.state === 'ready') finish({ port: p.port, token: p.token })
      else if (p.state === 'failed') fail(p.message)
    })

    // (2) Checks whether it was already ready (or had already given up) — in case it finished before the subscription
    const check = () => {
      void invoke<HostInfo | null>('host_info')
        .then((info) => info?.token && finish(info))
        .catch(() => {})
      void invoke<string | null>('host_error')
        .then((err) => err && fail(err))
        .catch(() => {})
    }
    check()

    // (3) Eventually catches up even if the event was missed
    const poll = setInterval(check, 400)
  })
}

/**
 * Restarts a supervisor that gave up (#184 — the failure screen's Retry). Reloading the
 * webview alone does not bring the host back up. Returns true if it started running, and
 * false if it was already running (an answer will follow shortly).
 */
export async function restartHost(): Promise<boolean> {
  return invoke<boolean>('restart_host').catch(rethrowAsError)
}

/**
 * The receiver for a quit request (`quit-requested`) (#184). Wired up once, **before the
 * first render**.
 *
 * The shell catches ⌘Q, the menu's Quit, and closing the window, all alike, and sends this
 * event to the webview. It used to be that the only listener was the app screen (the quit
 * modal), so on the screen waiting for the host and on the startup-failure screen, the event
 * vanished with nobody to receive it — the only way to close the app was from the Dock or by
 * force-quitting.
 *
 * If something to ask (a modal) is up, hands it off to that; if not, there is nothing to ask,
 * so it quits right away.
 * @returns a handle that installs something to ask (a function) or takes it down (null)
 */
export function listenForQuit(): (ask: (() => void) | null) => void {
  let ask: (() => void) | null = null
  void listen('quit-requested', () => {
    if (ask) ask()
    else void invoke('quit_app')
  })
  return (next) => {
    ask = next
  }
}

/**
 * Where a build came from (#280) — the keeper's record, as the shell hands it over. The host's own record (`HostBuild`,
 * protocol envelope.ts) with what only the keeper records: when it was built and the folder it runs from. The keeper's
 * record may lack the protocol version, so it is optional here. Named apart from this file's `ShellHostBuild`, the
 * shell's whole report, which used to share the protocol's name (#428).
 */
export type BuildSource = Omit<HostBuild, 'protocolVersion'> & {
  protocolVersion?: number
  builtAt?: string
  hostDir?: string
}

/**
 * Which builds are involved (#280): this window's and the running host's. `mode` says whether the
 * host is held by the keeper (release builds) or is the app's own child (`pnpm app:dev`).
 * `sameBuild` is false when a window of one build is attached to a host of another — the case the
 * window offers to switch. The shell's `HostBuild` (sidecar.rs), named apart from the protocol's `HostBuild`, which is
 * one host's record (#428).
 */
export type ShellHostBuild = {
  mode: 'keeper' | 'direct'
  app?: BuildSource
  host?: BuildSource
  sameBuild?: boolean
  /** The build of the keeper itself (#280 step 4); absent for a keeper older than step 4 */
  keeper?: BuildSource
  /**
   * False when the keeper is from another build than this window; switching moves it too. A keeper
   * older than step 4 (no `keeper`) counts as another build (#461), one only a full restart moves.
   * Absent when not attached to a keeper.
   */
  keeperSameBuild?: boolean
  background?: boolean
  /** The current or last blue-green swap (#280 step 3) */
  swap?: SwapView
  /** Whether the running host hands agents over in a swap (step 2) or stops them */
  keepsAgents?: boolean
  /** A session working or waiting, a terminal or a command running: what a switch could cost */
  busy?: boolean
  /**
   * This window was started by "Apply now" (#352): the keeper held on through the relaunch and
   * said so when the window attached. The window then switches by itself when nothing can be lost.
   */
  relaunched?: boolean
  /** How the last keeper start went through the macOS shell (thin-shell plan §6); absent when none was tried */
  shell?: ShellStart
}

export async function hostBuild(): Promise<ShellHostBuild> {
  return invoke<ShellHostBuild>('host_build').catch(rethrowAsError)
}

/**
 * Listens for changes to which builds are involved (a host restarted, a switch finished).
 * @returns a promise of the unsubscribe, settled once the listener is registered
 */
function listenHostBuild(cb: (b: ShellHostBuild) => void): Promise<() => void> {
  return listen<ShellHostBuild>('host-build', (e) => cb(e.payload))
}

/**
 * Follows which builds are involved: the current report, then every change (#850 item 17).
 *
 * The order is the one `waitForHost` keeps: the listener is registered first and only then is the current report
 * asked for. Asked the other way round, a report sent between the answer and the registration was missed, and an
 * answer read before a report but arriving after it put the older state back. Once a report has arrived, the
 * answer to the question is dropped for the same reason. `onAskFailed` is called when asking fails and no report
 * has arrived.
 */
export function watchHostBuild(cb: (b: ShellHostBuild) => void, onAskFailed?: () => void): () => void {
  let stopped = false
  let heard = false
  const un = listenHostBuild((b) => {
    if (stopped) return
    heard = true
    cb(b)
  })
  void un
    .then(() => hostBuild())
    .then(
      (b) => !stopped && !heard && cb(b),
      () => !stopped && !heard && onAskFailed?.(),
    )
  return () => {
    stopped = true
    void un.then((f) => f()).catch(() => {})
  }
}

/**
 * Switches the host to this window's build with the keeper's blue-green swap (#280 step 3). Returns
 * once the keeper has taken the request; the swap's phases arrive in `watchHostBuild` (`swap`), and the
 * window reconnects through the same front door. What it can cost is `switchPlan`'s to say.
 */
export async function switchHostBuild(): Promise<void> {
  await invoke('switch_host_build').catch(rethrowAsError)
}

/**
 * "Quit completely" (#280): stops the keeper, the host and everything they hold (agents,
 * terminals, running commands, app processes) whatever background mode says, then quits
 */
export async function quitAndStopAgents(): Promise<void> {
  await invoke('quit_and_stop_agents').catch(rethrowAsError)
}

/**
 * "Restart completely" (#387): stops the keeper and everything it holds, as "Quit completely" does,
 * but keeps this window open; the window then starts a keeper of its own build and reattaches.
 * For a keeper that could not move to this build by itself. Returns once the keeper has taken the
 * request; the reconnect arrives as `host-status` and `host-build`.
 */
export async function restartKeeper(): Promise<void> {
  await invoke('restart_keeper').catch(rethrowAsError)
}

/** Exported for testing — checks the seam with the Rust commands without a webview */
export class TauriSystemPort implements SystemPort {
  private granted: boolean | null = null

  private warned = false

  /**
   * A notification is **the only way to reach a person who has stepped away.** So if one could
   * not be sent, this says so.
   *
   * It used to just return if permission was missing. That leaves no way to ever find out "the
   * notification never came" — the code looks fine and nothing happens on screen, so the tool
   * ends up being the one suspected. Warns only once (raising it on every single notification
   * would be more noise than it is worth).
   */
  async notify(title: string, body: string): Promise<void> {
    if (this.granted === null) {
      this.granted = await asError(async () => (await isPermissionGranted()) || (await requestPermission()) === 'granted')
    }
    if (!this.granted) {
      if (this.warned) return
      this.warned = true
      throw new Error('Notifications are turned off — enable them for Centralu in System Settings')
    }
    await asError(() => sendNotification({ title, body }))
  }

  /**
   * Sound and the dock — **the path that actually reaches a person.**
   *
   * `notify` above is kept, but not trusted. Reading the plugin's source shows that on
   * desktop, `permission_state()` and `request_permission()` **both return the constant
   * `Ok(Granted)`**, and a delivery failure is dropped with `let _ = notification.show()`. In
   * other words, the `granted` check above checks nothing, and that throw never fires. On top
   * of that, the macOS path uses `NSUserNotification`, deprecated since 2018, so the banner
   * never shows up.
   *
   * So this side takes responsibility for whether a notification actually arrived. Throws on
   * failure — passing it through silently would once again make "the notification never came"
   * impossible to find out.
   */
  async alert(kind: AlertKind, sound: boolean): Promise<void> {
    await invoke('alert', { kind, sound }).catch(rethrowAsError)
  }

  async setBadge(count: number): Promise<void> {
    await invoke('set_badge', { count: Math.max(0, Math.trunc(count)) }).catch(rethrowAsError)
  }

  async openInIde(path: string, line?: number): Promise<void> {
    // If Rust's Err(String) arrived as-is, the screen would show "Could not open in IDE: undefined" (#159)
    await invoke('open_in_ide', { path, line }).catch(rethrowAsError)
  }

  /**
   * Calls the opener plugin's command directly — the exact command
   * `@tauri-apps/plugin-opener`'s `openUrl` calls, using the `opener:default` permission
   * (http/https addresses) and the one scoped entry beside it (VS Code Remote-SSH links, #82) already granted. Called by name to avoid pulling the plugin's JS
   * package into this package.
   */
  async openUrl(url: string): Promise<void> {
    await invoke('plugin:opener|open_url', { url }).catch(rethrowAsError)
  }

  async pickDirectory(): Promise<string | null> {
    return pickDirectory()
  }

  /** One file (M4 E-3 — the .zip to import). This is the dialog plugin's `open`, so it uses the `dialog:default` permission already granted, as is */
  async pickFile(opts: { title: string; extensions: string[] }): Promise<string | null> {
    const picked = await asError(() =>
      openDialog({ directory: false, multiple: false, title: opts.title, filters: [{ name: opts.title, extensions: opts.extensions }] }),
    )
    return typeof picked === 'string' ? picked : null
  }

  async startWindowDrag(): Promise<void> {
    await asError(() => getCurrentWindow().startDragging())
  }

  /**
   * The window's appearance and background (#312). `setTheme(null)` hands the appearance back to
   * the OS, which is what lets the webview's `prefers-color-scheme` follow it in System mode
   * (tauri.conf.json no longer holds the window to Dark). The background arrives as a computed
   * CSS colour (`rgb(15, 15, 15)`); Tauri wants channels, so anything else is left alone.
   */
  async setWindowAppearance(scheme: 'dark' | 'light' | null, background: string): Promise<void> {
    await asError(async () => {
      const win = getCurrentWindow()
      await win.setTheme(scheme)
      const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(background)
      if (rgb) await win.setBackgroundColor([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])])
    })
  }

  /**
   * App links (M4 E-4). The shell queues up links it received through the OS's open event and
   * calls `app-link` — that call means only "come get it," and the link itself is retrieved
   * with `take_app_links` (retrieving it clears it from the shell). Drains once as soon as
   * subscribed: if the app was launched by a link, a link that arrived before the webview came
   * up is already sitting in the queue.
   */
  onAppLink(cb: (link: string) => void): () => void {
    let alive = true
    const drain = () =>
      void invoke<string[]>('take_app_links')
        .then((links) => {
          if (alive) for (const l of links) cb(l)
        })
        .catch(() => {})
    const un = listen('app-link', drain)
    drain()
    return () => {
      alive = false
      void un.then((f) => f())
    }
  }
}

/** Brings the window forward (a notification click, a global shortcut) */
export async function focusWindow(): Promise<void> {
  await invoke('focus_window').catch(rethrowAsError)
}

/** Directory picker — replaces typing a path, which is what web dev does instead (FR-19) */
export async function pickDirectory(): Promise<string | null> {
  const picked = await asError(() => openDialog({ directory: true, multiple: false, title: 'Choose project directory' }))
  return typeof picked === 'string' ? picked : null
}

/**
 * "Apply now" (#352) through the Rust shell: `relaunch_info` says whether this window's bundle on
 * disk now holds another build, `apply_update_relaunch` tells the keeper and relaunches, and the
 * keeper's activity report (in `host-build`) is what an automatic apply waits on.
 */
export function tauriRelaunchPort(): RelaunchPort {
  return {
    check: () => invoke<RelaunchCheck>('relaunch_info').catch((e: unknown) => ({ ready: false, reason: toError(e).message })),
    relaunch: () => invoke<void>('apply_update_relaunch').catch(rethrowAsError),
    watchBusy: (cb) =>
      watchHostBuild(
        (b) => cb(typeof b.busy === 'boolean' ? b.busy : null),
        () => cb(null),
      ),
  }
}

export type TauriPlatform = Platform & { relaunchSwap: RelaunchSwapResult }

/**
 * Follows the host's address from before the first read of it (#972 item 1).
 *
 * The order `waitForHost` keeps, for the whole of startup: the listener is registered first, and only then is the
 * address read. Startup reads the address and then awaits several more shell calls before the web platform exists; a
 * `ready` for a new port in that gap (a crash restart, a swap) used to be lost, and the client retried the old
 * address forever. Here the latest `ready` heard is kept, and handed to the web platform the moment it subscribes,
 * then every later one; the client ignores an address it already has.
 */
async function followEndpoint(): Promise<{
  onEndpointChange: (cb: (info: HostInfo) => void) => () => void
  stop: () => void
}> {
  let latest: HostInfo | null = null
  let forward: ((info: HostInfo) => void) | null = null
  let stopped = false
  // A listener that cannot be registered costs only the following, as it did before: startup itself goes on
  const un = await listenHostStatus((p) => {
    if (stopped || p.state !== 'ready') return
    latest = { port: p.port, token: p.token }
    forward?.(latest)
  }).catch(() => () => {})
  const stop = () => {
    if (stopped) return
    stopped = true
    forward = null
    un()
  }
  return {
    onEndpointChange: (cb) => {
      forward = cb
      if (latest) cb(latest)
      return stop
    },
    stop,
  }
}

export async function createTauriPlatform(): Promise<TauriPlatform> {
  const endpoint = await followEndpoint()
  try {
    return await createOnHost(endpoint.onEndpointChange)
  } catch (e) {
    endpoint.stop()
    throw e
  }
}

async function createOnHost(onEndpointChange: (cb: (info: HostInfo) => void) => () => void): Promise<TauriPlatform> {
  await waitForHost()
  const attached = await hostBuild().catch(() => null)
  const relaunchSwap = attached
    ? await finishRelaunchSwap(attached, listenHostBuild, switchHostBuild)
    : { tried: false }
  const { port, token } = await waitForHost()

  // Ask the shell how much of our top bar the OS has already claimed. Only Rust knows
  // (it is a build-time `cfg!`), and this is the one place allowed to know it — the
  // number reaches ui as a width, never as an OS name.
  // A failure here must not stop the app from starting: a wrong inset is a cosmetic
  // problem, and blocking startup over one would turn it into a fatal one.
  const windowControlsInset = await invoke<number>('window_controls_inset').catch(() => 0)

  // Same deal for the two modifier keys we print: only Rust knows which keyboard is under
  // the app, and the labels reach ui as words, never as an OS name (#32).
  // The fallback is the Mac spelling because a failure here can only mean the command is
  // missing from the handler list, which is a build-time mistake affecting every platform
  // equally — and every other implementation in this package answers the same way.
  const shortcutKeys = await invoke<ShortcutKeys>('shortcut_keys').catch(
    (): ShortcutKeys => ({ mod: '⌘', alt: '⌥', join: '' }),
  )

  // And the same again for what this desktop calls its file manager (#19), so the context
  // menu can say "Reveal in Finder" here without ui ever learning which OS it is on.
  const fileManagerName = await invoke<string>('file_manager_name').catch(() => 'file manager')

  // Background mode exists only when the keeper holds the host (#280). A failure to ask is read
  // as "no keeper": the setting then stays hidden instead of offering a switch that cannot work.
  const mode = await hostBuild()
    .then((b) => b.mode)
    .catch(() => 'direct' as const)

  // If the supervisor revives the host, the port and token change → this has to switch to the new address.
  // Without this subscription, the app stays stuck at 'disconnected' after the sidecar crashes (measured at L4-2).
  // It was registered before the address above was read (`followEndpoint`), so a restart during startup is not missed.
  const base = createWebPlatform({
    hostUrl: `ws://127.0.0.1:${port}`,
    token,
    fileManagerName,
    /*
      The trash and "reveal in file manager" are the two things the host cannot do (#18/#19).
      A real trash is macOS's `NSFileManager trashItem` or the freedesktop spec, not an unlink
      that moves a file to a temp folder, so this goes down to Rust here rather than through
      the Node sidecar. Building the path is still the host's job — it is the only side that
      knows the project root.
    */
    nativeFiles: {
      trash: (path) => invoke<void>('trash_path', { path }).catch(rethrowAsError),
      reveal: (path) => invoke<void>('reveal_path', { path }).catch(rethrowAsError),
    },
    onEndpointChange,
  })

  return {
    ...base,
    relaunchSwap: { ...relaunchSwap, previousSwapStartedAt: attached?.swap?.startedAt },
    ...(mode === 'keeper'
      ? {
          background: {
            get: () => invoke<boolean>('background_mode').catch(rethrowAsError),
            set: (on: boolean) => invoke<boolean>('set_background_mode', { on }).catch(rethrowAsError),
          },
          relaunch: tauriRelaunchPort(),
        }
      : {}),
    system: new TauriSystemPort(),
    capabilities: {
      osNotifications: true,
      dockBadge: true,
      globalShortcuts: true,
      processSupervision: true,
      openInIde: true,
      windowControlsInset,
      shortcutKeys,
      fileManagerName,
      // WKWebView or WebKitGTK answers false, WebView2 true: the webview answers for itself
      frameDragEndInPage: frameDragEndInPage(),
    },
  }
}

export type { HostStatus }
