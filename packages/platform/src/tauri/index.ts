import { ANY_FILE_MANAGER, MAC_SHORTCUT_KEYS, badgeCount } from '../capabilities.js'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AlertKind, Platform, RelaunchCheck, RelaunchPort, ShortcutKeys, SystemPort, WindowAction } from '../ports/index.js'
import type { HostBuild } from '@cc/protocol/client'
import { isRecord, type StoreWork, storeWorkOf } from '@cc/protocol/client'
import { createWebPlatform } from '../web/index.js'
import { asError, rethrowAsError, toError } from './to-error.js'
import type { ShellStart } from './switch-plan.js'

export { keepRunningThenQuit } from './keep-running.js'

export {
  autoRestart,
  buildBar,
  restartPlan,
  shellBarText,
  type BuildBar,
  type RestartPlan,
  type ShellStart,
} from './switch-plan.js'

/**
 * The Tauri implementation (docs/platform-abstraction.md §5): the web platform as is, with the host's port and token
 * from the shell's supervisor and a system port of real OS calls.
 */

type HostInfo = { port: number; token: string }

/** The shell reads it from host.lock (`host_store_work`) */
export type { StoreWork }

type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; port: number; token: string }
  | { state: 'restarting'; attempt: number }
  | { state: 'failed'; message: string }

const isHostStatus = (p: unknown): p is HostStatus => isRecord(p) && typeof p.state === 'string'

/**
 * The one reader of the shell's `host-status` report.
 * @returns a promise of the unsubscribe, settled once the listener is registered
 */
function listenHostStatus(cb: (status: HostStatus) => void): Promise<() => void> {
  return listen<unknown>('host-status', (e) => {
    const p = e.payload
    if (isHostStatus(p)) cb(p)
  })
}

export function onHostStatus(cb: (status: HostStatus) => void): () => void {
  const un = listenHostStatus(cb)
  return () => void un.then((f) => f()).catch(() => {})
}

/**
 * Waits for the sidecar, which comes up after the app. Subscribes first, then asks, then polls: asked the other way
 * round, a readiness in between is missed and the wait runs to the timeout (the host can be up in under a second).
 * The poll asks for a failure too: the supervisor leaves one only when it gives up, and a `failed` sent before the
 * webview listens would otherwise cost the full 30 s. A host working on its store (#2334: a copy before an update, a
 * long step) is not late: while the shell reports it the timeout starts over, and `onStoreWork` hears each change.
 */
async function waitForHost(timeoutMs = 30_000, onStoreWork: (work: StoreWork | null) => void = () => {}): Promise<HostInfo> {
  return new Promise<HostInfo>((resolve, reject) => {
    let done = false
    const stop = () => {
      done = true
      clearTimeout(timer)
      clearInterval(poll)
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

    const expire = () => {
      void invoke<string | null>('host_error')
        .catch(() => null)
        .then((err) => fail(err ?? 'agent-host did not become ready in time'))
    }
    let timer = setTimeout(expire, timeoutMs)
    let saidWork: string | undefined

    const unlisten = listenHostStatus((p) => {
      if (p.state === 'ready') finish({ port: p.port, token: p.token })
      else if (p.state === 'failed') fail(p.message)
    })

    const check = () => {
      void invoke<HostInfo | null>('host_info')
        .then((info) => info?.token && finish(info))
        .catch(() => {})
      void invoke<string | null>('host_error')
        .then((err) => err && fail(err))
        .catch(() => {})
      void invoke<unknown>('host_store_work')
        .then((w) => {
          if (done) return
          const work = storeWorkOf(w)
          // Only on a change: a screen drawn again on each check would never tick its clock
          const key = JSON.stringify(work)
          if (key !== saidWork) onStoreWork(work)
          saidWork = key
          if (!work) return
          clearTimeout(timer)
          timer = setTimeout(expire, timeoutMs)
        })
        .catch(() => {})
    }
    check()

    const poll = setInterval(check, 400)
  })
}

/**
 * The failure screen's Retry (docs/runtime-lessons/single-instance-and-supervision.md SU2): reloading the webview
 * alone does not bring the host back. False when the supervisor was already running; its answer follows.
 */
export async function restartHost(): Promise<boolean> {
  return invoke<boolean>('restart_host').catch(rethrowAsError)
}

export async function quitApp(): Promise<void> {
  await invoke('quit_app').catch(rethrowAsError)
}

/**
 * The receiver of the shell's `quit-requested` (⌘Q, the menu's Quit, closing the window;
 * docs/runtime-lessons/quit-relaunch-update.md UP1), wired once before the first render: with only the quit modal
 * listening, a quit on the startup screens goes nowhere. Hands it to what is installed to ask, or quits at once.
 * @returns a handle that installs something to ask (a function) or takes it down (null)
 */
export function listenForQuit(): (ask: (() => void) | null) => void {
  let ask: (() => void) | null = null
  void listen('quit-requested', () => {
    if (ask) ask()
    else void quitApp().catch((e: Error) => console.error('Could not quit:', e.message))
  })
  return (next) => {
    ask = next
  }
}

/** The keeper's record of a build, as the shell hands it over: the host's own record, the protocol version optional */
export type BuildSource = Omit<HostBuild, 'protocolVersion'> & {
  protocolVersion?: number
  builtAt?: string
  hostDir?: string
}

/**
 * The shell's `HostBuild` (sidecar/mod.rs), named apart from the protocol's (protocol.md §4). `mode` `direct`: the
 * host is the app's own child (`pnpm app:dev`). `sameBuild` false: a restart into this window's build is offered.
 */
export type ShellHostBuild = {
  mode: 'keeper' | 'direct' | 'serve'
  app?: BuildSource
  host?: BuildSource
  sameBuild?: boolean
  /** Absent from a keeper older than #280 step 4 */
  keeper?: BuildSource
  /** A keeper without `keeper` counts as another build (#461); absent when not attached to a keeper */
  keeperSameBuild?: boolean
  background?: boolean
  /**
   * The keeper stops for an update (#1895 step 3), so a restart into this build continues the turns it cuts; an earlier
   * keeper gets a plain stop. Absent before the keeper's first report
   */
  stopsForUpdate?: boolean
  /** What a restart could cost (docs/runtime-lessons/front-door-and-store.md SW16) */
  busy?: boolean
  /** The last keeper start through the macOS shell (docs/plans/thin-shell.md §6); absent when none was tried */
  shell?: ShellStart
}

export async function hostBuild(): Promise<ShellHostBuild> {
  return invoke<ShellHostBuild>('host_build').catch(rethrowAsError)
}

const isHostBuild = (p: unknown): p is ShellHostBuild => isRecord(p) && typeof p.mode === 'string'

/** @returns a promise of the unsubscribe, settled once the listener is registered */
function listenHostBuild(cb: (b: ShellHostBuild) => void): Promise<() => void> {
  return listen<unknown>('host-build', (e) => {
    const p = e.payload
    if (isHostBuild(p)) cb(p)
  })
}

/**
 * The current report, then every change. Registers first, then asks, as `waitForHost` does; once a report has
 * arrived the answer is dropped, since an answer read before a report but arriving after it would put the older state
 * back. `onAskFailed`: asking failed and no report has arrived.
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

/** "Quit completely": stops the keeper, the host and all they hold whatever background mode says, then quits */
export async function quitAndStopAgents(): Promise<void> {
  await invoke('quit_and_stop_agents').catch(rethrowAsError)
}

/**
 * The build bar's restart into this build (docs/runtime-lessons/quit-relaunch-update.md UP8). Returns once the keeper
 * took the request (a stop for an update answers once its host is gone); the reconnect arrives as `host-status` and
 * `host-build`.
 */
export async function restartKeeper(): Promise<void> {
  await invoke('restart_keeper').catch(rethrowAsError)
}

/** Exported for the tests of the seam with the Rust commands */
export class TauriSystemPort implements SystemPort {
  private granted: boolean | null = null

  private warned = false

  /** Says once when it cannot notify: returning quietly leaves "the notification never came" unexplained */
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
   * Sound and the dock: the path that reaches a person. On desktop the notification plugin's `permission_state()` and
   * `request_permission()` both return a constant `Ok(Granted)` and it drops a delivery failure
   * (`let _ = notification.show()`), so `notify`'s check checks nothing; on macOS it uses `NSUserNotification`,
   * deprecated since 2018, whose banner never shows. Throws on failure, so a lost alert is never silent.
   */
  async alert(kind: AlertKind, sound: boolean): Promise<void> {
    await invoke('alert', { kind, sound }).catch(rethrowAsError)
  }

  async setBadge(count: number): Promise<void> {
    await invoke('set_badge', { count: badgeCount(count) }).catch(rethrowAsError)
  }

  async windowAction(action: WindowAction): Promise<void> {
    const w = getCurrentWindow()
    // close() asks first: the shell turns it into the quit question (docs/runtime-lessons/quit-relaunch-update.md UP2)
    if (action === 'minimize') await w.minimize().catch(rethrowAsError)
    else if (action === 'toggleMaximize') await w.toggleMaximize().catch(rethrowAsError)
    else await w.close().catch(rethrowAsError)
  }

  async openInIde(path: string, line?: number): Promise<void> {
    await invoke('open_in_ide', { path, line }).catch(rethrowAsError)
  }

  /**
   * The command `@tauri-apps/plugin-opener`'s `openUrl` calls, by name so that package stays out of this one; under
   * `opener:default` (http/https) and the scoped entry beside it (VS Code Remote-SSH links, #82).
   */
  async openUrl(url: string): Promise<void> {
    await invoke('plugin:opener|open_url', { url }).catch(rethrowAsError)
  }

  async pickDirectory(): Promise<string | null> {
    return pickDirectory()
  }

  /** The dialog plugin's `open`, under the `dialog:default` permission already granted */
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
   * `setTheme(null)` hands the appearance back to the OS, which lets the webview's `prefers-color-scheme` follow it
   * (tauri.conf.json does not hold the window to Dark). Tauri wants channels: a background that is not `rgb()` is left.
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
   * The shell queues the links the OS opened it with and sends `app-link` to say "come get them"; `take_app_links`
   * takes and clears them. Drains once at once: a link that launched the app is already queued. A link taken for a
   * listener that left meanwhile goes to another or waits for the next, kept per window since a new platform makes a
   * new port.
   */
  onAppLink(cb: (link: string) => void): () => void {
    let alive = true
    const drain = () =>
      void invoke<string[]>('take_app_links')
        .then((links) => {
          if (alive) for (const l of links) cb(l)
          else handOnAppLinks(links)
        })
        .catch(() => {})
    appLinkListeners.add(cb)
    for (const l of heldAppLinks.splice(0)) cb(l)
    const un = listen('app-link', drain)
    drain()
    return () => {
      alive = false
      appLinkListeners.delete(cb)
      void un.then((f) => f()).catch(() => {})
    }
  }
}

/** The app-link listeners of this window, on any port */
const appLinkListeners = new Set<(link: string) => void>()
const heldAppLinks: string[] = []

function handOnAppLinks(links: string[]): void {
  const listener = appLinkListeners.values().next().value
  if (!listener) return void heldAppLinks.push(...links)
  for (const l of links) listener(l)
}

export async function focusWindow(): Promise<void> {
  await invoke('focus_window').catch(rethrowAsError)
}

export async function pickDirectory(): Promise<string | null> {
  const picked = await asError(() => openDialog({ directory: true, multiple: false, title: 'Choose project directory' }))
  return typeof picked === 'string' ? picked : null
}

/**
 * "Apply now" through the shell (docs/runtime-lessons/quit-relaunch-update.md UP4, UP6). An automatic apply waits on
 * the keeper's activity report (in `host-build`): without a keeper there is none, so nothing applies by itself there.
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

export type TauriPlatform = Platform

/**
 * Follows the host's address from before the first read of it: startup awaits several shell calls before the web
 * platform exists, and a `ready` for a new port in that gap (a crash restart, a swap) would leave the client on the
 * old address for good. The latest `ready` is handed over when the web platform subscribes, then every later one.
 */
async function followEndpoint(): Promise<{
  onEndpointChange: (cb: (info: HostInfo) => void) => () => void
  stop: () => void
}> {
  let latest: HostInfo | null = null
  let forward: ((info: HostInfo) => void) | null = null
  let stopped = false
  // A listener that cannot be registered costs only the following, not the startup
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

export async function createTauriPlatform({ onStoreWork }: { onStoreWork?: (work: StoreWork | null) => void } = {}): Promise<TauriPlatform> {
  const endpoint = await followEndpoint()
  try {
    return await createOnHost(endpoint.onEndpointChange, onStoreWork)
  } catch (e) {
    endpoint.stop()
    throw e
  }
}

async function createOnHost(onEndpointChange: (cb: (info: HostInfo) => void) => () => void, onStoreWork?: (work: StoreWork | null) => void): Promise<TauriPlatform> {
  const { port, token } = await waitForHost(undefined, onStoreWork)

  // Only Rust knows the OS (a build-time `cfg!`); ui gets widths and words, never an OS name. A failed ask must not
  // stop the start: a wrong inset is cosmetic. `MAC_SHORTCUT_KEYS` says why the keys fall back to it.
  const windowControlsInset = await invoke<number>('window_controls_inset').catch(() => 0)

  const shortcutKeys = await invoke<ShortcutKeys>('shortcut_keys').catch((): ShortcutKeys => MAC_SHORTCUT_KEYS)

  const fileManagerName = await invoke<string>('file_manager_name').catch(() => ANY_FILE_MANAGER)

  // Windows, where the shell turned the OS title bar off
  const windowControls = await invoke<boolean>('window_controls_drawn').catch(() => false)

  // Background mode needs the keeper (#280); a failed ask reads as none, which hides a switch that cannot work
  const mode = await hostBuild()
    .then((b) => b.mode)
    .catch(() => 'direct' as const)
  const servesHost = mode === 'serve'

  // `onEndpointChange` follows a revived host's new port and token (docs/runtime-lessons/front-door-and-store.md SW1)
  const base = createWebPlatform({
    hostUrl: `ws://127.0.0.1:${port}`,
    token,
    // frameDragEndInPage is left to the webview itself (engine.ts)
    capabilities: { windowControlsInset, shortcutKeys, fileManagerName, windowControls, servesHost },
    // A real trash is `NSFileManager trashItem` or the freedesktop spec, which Node cannot do (`WebPlatformOptions`)
    nativeFiles: {
      trash: (path) => invoke<void>('trash_path', { path }).catch(rethrowAsError),
      reveal: (path) => invoke<void>('reveal_path', { path }).catch(rethrowAsError),
    },
    onEndpointChange,
  })

  return {
    ...base,
    ...(mode === 'keeper'
      ? {
          background: {
            get: () => invoke<boolean>('background_mode').catch(rethrowAsError),
            set: (on: boolean) => invoke<boolean>('set_background_mode', { on }).catch(rethrowAsError),
          },
        }
      : {}),
    // Without a keeper too: the shell says whether it can relaunch
    relaunch: tauriRelaunchPort(),
    system: new TauriSystemPort(),
  }
}

export type { HostStatus }
