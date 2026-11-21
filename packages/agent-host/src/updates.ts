import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { APP_NAME, APP_SLUG, APP_VERSION, errorMessage, isNewerVersion, keepsInstalledCopy, type UpdateStatus } from '@cc/protocol'
import { HOST_PLATFORM, installedCopyPath, installedCopyVersionSource, npmMachine, type Platform } from './os.js'
import { resolveCommand, type ToolLaunch } from './tool-launch.js'
import { execText, execTextSync } from './os/exec.js'
import { sleep } from './timing.js'

/**
 * The in-app update check (#43), run in the host rather than the launcher: the launcher's copy is the one already on the
 * machine (beta.1's compares versions wrong, #42) and no fix reaches it retroactively, while a check in the host ships with the
 * app. It notifies and installs when asked or allowed: the check is read-only and its failures swallowed; replacing the running
 * program happens by a click, or by itself with `autoApply` (#352, update-switches.ts). The host stops at `restart_required`:
 * only the window knows whether someone is typing, and the keeper's switch afterwards keeps every running turn
 */

/** The registry is the update channel — no server of ours, no signing keys (same as the launcher) */
const REGISTRY_URL = `https://registry.npmjs.org/${APP_SLUG}/latest`

/**
 * How often to look again while the app runs: an app left open for days would never hear of Wednesday's release from a
 * startup-only check; six hours is at most four requests a day. Explicit checks and installs refresh sooner (#635)
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Two deadlines: the scheduled check is background noise and gives up quickly and silently; "Check now" has a person waiting
 * and waits as long as the launcher's own `update`
 */
const SCHEDULED_TIMEOUT_MS = 3_000
const FORCED_TIMEOUT_MS = 8_000
const INSTALL_CHECK_MAX_AGE_MS = 60_000
// A recent observation may outpace an npm edge; older tags must yield to a rollback
const STORED_RELEASE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * How long automatic installs wait before retrying a failed one (#645): soon the first time, then a step back, then the check
 * interval, so a persistent cause (EACCES, a full disk) costs one `npm i -g` per six hours while a network blip or an npm edge
 * that has not caught up does not switch them off for the host's life (#636). In memory only: a new host starts over, which
 * fixes most causes
 */
const AUTO_RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000]

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// npm can publish the dist-tag before every registry edge has the tarball: wait for propagation, not a person
const NPM_RETRY_DELAY_MS = 30_000
const NPM_RETRY_WINDOW_MS = 10 * 60 * 1000

/** The registry's answer; failure is a value too, since throwing would force the caller to stop the app */
export type LatestResult = { ok: true; version: string } | { ok: false; reason: string }

/** What a source tree's version carriers hold until a build stamps them: the same as `scripts/app-version.mjs` PLACEHOLDER */
const UNSTAMPED_VERSION = '0.0.0-dev'

/**
 * Whether this build may install a release by itself (#1501): never a host run from source (`build` `dev`) nor one with the placeholder version.
 * Every release is newer than `0.0.0-dev`, so a stored "Automatic updates" on would run `npm i -g centralu@<latest>` on the machine of whoever runs
 * `pnpm host` against their own data folder. The update line still shows the release; a click installs it
 */
function installsByItself(build: string | undefined, current: string): boolean {
  return build !== 'dev' && current !== UNSTAMPED_VERSION
}

/**
 * Whether this hub updates its linked machines by itself to its own version (#1508, `LinkDeps.autoUpdate`): "Automatic updates"
 * on, not mid-swap, from a build that may install by itself (`installsByItself`). A dev hub's machines would refuse anyway
 * (`channel('0.0.0-dev')` is `dev`); this does not rely on it
 */
export function hubUpdatesMachines(f: { build: string; current: string; autoApply: boolean; draining: boolean }): boolean {
  return installsByItself(f.build, f.current) && f.autoApply && !f.draining
}

/**
 * What the service reaches of the machine, each given and none defaulted (#2299): the registry, `npm i -g`, the global npm
 * package and the app copy. A defaulted one reached the real machine from any test that left it out, and a test passed or
 * failed by what was installed there. The host gets the real ones from `realUpdateService`, a test fakes them
 * (`isolatedUpdateService`, `updates.test-helpers.ts`); a seam added here is required, so a type error finds every builder
 */
export type UpdateMachine = {
  fetchLatest: (timeoutMs: number) => Promise<LatestResult>
  run: (file: string, args: string[]) => Promise<void>
  installedCopy: () => string | null
  installedCopyVersion: (copy: string) => string | null
  globalPackage: () => Promise<GlobalPackage | null>
}

/** What else the service is given, none of it reaching the machine: tests give some of it, the host the rest */
export type UpdateServiceOptions = {
  /** The version this build is: `APP_VERSION` when not given; tests give a release, as a source tree carries the placeholder `0.0.0-dev` (#1501) */
  current?: string
  build?: string
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  readAuto?: () => boolean
  writeAuto?: (enabled: boolean) => void
  readAutoApply?: () => boolean
  writeAutoApply?: (enabled: boolean) => void
  wait?: (ms: number) => Promise<void>
  node?: string
}

type UpdateDeps = UpdateMachine & UpdateServiceOptions

export { installedCopyPath }

/**
 * The globally installed npm package: its launcher's path and version (null when unreadable), and this machine's platform
 * package as that launcher finds it (#2282): name and version (null when npm left it out), or null when the package lists none
 * for this machine
 */
export type GlobalPackage = { launcher: string; version: string | null; platform: { name: string; version: string | null } | null }

/**
 * The globally installed npm package, found by `npm root -g`; `install` runs its launcher by path, not `centralu` from PATH,
 * which on a hub-managed machine may be the hub's shim (`<data>/remote/bin`) whose `install` has no desktop app to copy
 */
async function npmGlobalPackage(): Promise<GlobalPackage | null> {
  const cmd = commandFor('npm', ['root', '-g'])
  const out = await execText(cmd.file, cmd.args, { timeoutMs: 60_000 }).then((r) => r.stdout, () => '')
  const root = out.trim().split(/\r?\n/).at(-1)?.trim()
  if (!root) return null
  const launcher = join(root, APP_SLUG, 'bin', `${APP_SLUG}.mjs`)
  if (!existsSync(launcher)) return null
  const manifest = join(root, APP_SLUG, 'package.json')
  return { launcher, version: packageVersion(manifest), platform: platformPackage(launcher, manifest, npmMachine()) }
}

/**
 * This machine's platform package (`@centralu/<os>-<arch>`) beside a launcher (#2282). The package's `optionalDependencies` say
 * which machines have one (the launcher's `TARGETS`, held to them by `tooling/launcher-platform.test.ts`): a machine it lists
 * none for has none by design. Found as the launcher does (`bundledApp`, `require.resolve`); npm skips an optional dependency
 * it could not fetch and exits 0, leaving the version null
 */
export function platformPackage(launcher: string, manifest: string, machine: string): { name: string; version: string | null } | null {
  const name = `@${APP_SLUG}/${machine}`
  if (!Object.hasOwn(optionalDependencies(manifest), name)) return null
  try {
    return { name, version: packageVersion(createRequire(launcher).resolve(`${name}/package.json`)) }
  } catch {
    return { name, version: null }
  }
}

function optionalDependencies(file: string): Record<string, unknown> {
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const deps = typeof pkg === 'object' && pkg !== null && 'optionalDependencies' in pkg ? pkg.optionalDependencies : null
    return typeof deps === 'object' && deps !== null ? { ...deps } : {}
  } catch {
    return {}
  }
}

export function existingCopy(path: string, platform: Platform = HOST_PLATFORM): string | null {
  if (!existsSync(path)) return null
  // A menu entry whose AppImage is gone (its package was uninstalled) is no copy: refreshing it would reinstall that
  const app = installedCopyVersionSource(path, platform)?.kind === 'menu-entry' ? menuEntryApp(path) : null
  return app !== null && !existsSync(app) ? null : path
}

const WELL_FORMED = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

function atLeast(version: string | null, than: string): boolean {
  return version !== null && WELL_FORMED.test(version) && !isNewerVersion(than, version)
}

/**
 * The version the installed copy carries, null when there is none to read (#645): how is the platform's answer
 * (`installedCopyVersionSource`); unreadable is unknown, and `keepsInstalledCopy` replaces a copy whose version is unknown or
 * malformed
 */
export function readInstalledCopyVersion(copy: string, platform: Platform = HOST_PLATFORM): string | null {
  const source = installedCopyVersionSource(copy, platform)
  if (!source) return null
  try {
    if (source.kind === 'menu-entry') {
      const app = menuEntryApp(copy)
      return app ? packageVersion(join(dirname(app), 'package.json')) : null
    }
    const text =
      source.kind === 'plutil'
        ? execTextSync('/usr/bin/plutil', source.args, { timeoutMs: 5_000 }).stdout
        : readFileSync(join(copy, source.name), 'utf8')
    return text.trim() || null
  } catch {
    return null
  }
}

function menuEntryApp(entry: string): string | null {
  try {
    return /^Exec="([^"]+)"/m.exec(readFileSync(entry, 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

function packageVersion(file: string): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : null
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

/**
 * Asks the registry; never throws, as its caller is a timer or a screen that must work offline. Reasons stay apart because they
 * send the person elsewhere: unreachable means check the network, 404 that looking will not help (renamed or unpublished)
 */
async function fetchLatestFromRegistry(timeoutMs: number): Promise<LatestResult> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { ok: false, reason: `${APP_SLUG} is not on the registry` }
    if (!res.ok) return { ok: false, reason: `The registry answered ${res.status}` }
    const body: unknown = await res.json()
    const version = typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined
    return typeof version === 'string'
      ? { ok: true, version }
      : { ok: false, reason: 'The registry answered in an unexpected shape' }
  } catch {
    return { ok: false, reason: 'Could not reach the registry — check the network' }
  }
}

/**
 * The program and arguments that run `file args` without a shell. On Windows `npm` and `centralu` are batch files: `execFile`
 * finds no bare `npm` (libuv tries `.com` and `.exe` only: ENOENT, the "Update failed" of every Windows build up to
 * 0.1.0-beta.12) and Node refuses a `.cmd` by path (EINVAL since CVE-2024-27980). The launcher's `update` uses a shell, but
 * `tool-launch.ts` already reads a batch file for the program it starts, so no argument passes through cmd.exe. Elsewhere `file
 * args` unchanged
 */
export function commandFor(
  file: string,
  args: string[],
  resolve: (file: string) => ToolLaunch = (f) => resolveCommand(f),
): { file: string; args: string[] } {
  const launch = resolve(file)
  return { file: launch.command, args: [...launch.args, ...args] }
}

/** npm's advice under every E404 ("you can also install from a tarball…"), with its blank 404 lines */
const NPM_404_NOTE = /^npm (?:error|ERR!) 404(?:\s+Note that you can also install from a|\s+tarball, folder, http url, or git (?:url|repo)\.)?$/i

/**
 * The line of a failed command's stderr that says why: npm puts its cause last, then a line on where its log went (passed over,
 * as is the advice under an E404, `NPM_404_NOTE`); the launcher (`centralu install`) puts its cause first and then "Quit it,
 * then run the command again", which reads wrong inside the app
 */
export function failureDetail(file: string, stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/complete log of this run/i.test(l) && !NPM_404_NOTE.test(l))
  return (file === 'npm' ? lines.at(-1) : lines[0]) ?? null
}

function stderrOf(e: unknown): string {
  return e instanceof Error && 'stderr' in e && typeof e.stderr === 'string' ? e.stderr : ''
}

/**
 * A failed command in one line for the host log: its exit code and first line naming an error (npm's `npm error code
 * ENOTFOUND`), where `failureDetail` keeps npm's last line for the update line
 */
export function failureLine(e: unknown): string {
  const stderr = stderrOf(e)
  const code = e instanceof Error && 'exitCode' in e && (typeof e.exitCode === 'number' || typeof e.exitCode === 'string') ? `exit ${e.exitCode}: ` : ''
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => /\berr(?:or)?\b|ERR!/i.test(l) && !/complete log of this run/i.test(l))
  return `${code}${line ?? errorMessage(e)}`
}

export function runCommand(file: string, args: string[], resolve?: (file: string) => ToolLaunch): Promise<void> {
  const cmd = commandFor(file, args, resolve)
  // npm and the launcher are console programs; the run gives them no window, whatever console the host has
  return execText(cmd.file, cmd.args, { timeoutMs: INSTALL_TIMEOUT_MS }).then(
    () => undefined,
    (err: Error & { code?: unknown; stderr?: string }) => {
      if (err.code === 'ENOENT') throw new Error(`${file} was not found on PATH (${err.message})`)
      const stderr = String(err.stderr ?? '')
      throw Object.assign(new Error(failureDetail(file, stderr) || err.message), { exitCode: err.code, stderr })
    },
  )
}

export class UpdateService {
  private status: UpdateStatus
  private stopped = false
  private installing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly deps: Required<UpdateDeps>
  private inFlight: Promise<UpdateStatus> | null = null
  private retry: { version: string; failures: number; at: number } | null = null
  private retryTimer: (() => void) | null = null
  private following: Promise<void> | null = null
  /**
   * The release this host installed and waits to be restarted into (`restart_required`), with the notice it carried (#2130); a
   * newer release passes it, the same or an older one is never offered or installed again
   */
  private installed: { version: string; error: string | null } | null = null
  private applying: Promise<UpdateStatus> | null = null

  constructor(
    private publish: (status: UpdateStatus) => void,
    deps: UpdateDeps,
  ) {
    this.deps = {
      current: deps.current ?? APP_VERSION,
      build: deps.build ?? '',
      fetchLatest: deps.fetchLatest,
      run: deps.run,
      installedCopy: deps.installedCopy,
      installedCopyVersion: deps.installedCopyVersion,
      now: deps.now ?? Date.now,
      schedule:
        deps.schedule ??
        ((fn, ms) => {
          const t = setTimeout(fn, ms)
          // A pending retry must not hold the process open, no more than the check timer does
          t.unref?.()
          return () => clearTimeout(t)
        }),
      // No place to persist it: automatic checking is on, as main.ts passes
      readAuto: deps.readAuto ?? (() => true),
      writeAuto: deps.writeAuto ?? (() => {}),
      readAutoApply: deps.readAutoApply ?? (() => false),
      writeAutoApply: deps.writeAutoApply ?? (() => {}),
      wait: deps.wait ?? sleep,
      globalPackage: deps.globalPackage,
      node: deps.node ?? process.execPath,
    }
    this.status = {
      /*
       * `APP_VERSION` is what the app was compiled from: the version a release stamped into the build (#1501,
       * `tooling/brand.test.ts`) or the source tree's placeholder `0.0.0-dev`; the workspace root's package.json is private and would
       * read `0.0.0` forever
       */
      current: this.deps.current,
      latest: null,
      newer: false,
      auto: this.deps.readAuto(),
      autoApply: this.deps.readAutoApply(),
      phase: 'idle',
      error: null,
      checkedAt: null,
    }
  }

  current(): UpdateStatus {
    return { ...this.status }
  }

  /**
   * Starts checking, once at host start; the first check goes out at once, as the app was closed while releases happened and
   * startup is when the answer is most likely stale
   */
  start(): void {
    this.stopped = false
    if (!this.status.auto) return
    void this.check(false)
    this.startTimer()
  }

  /** Shutdown (including a host swap): no asynchronous continuation may start more work */
  stop(): void {
    this.stopped = true
    this.stopTimer()
    this.cancelRetry()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS)
    // Not held open for a version check: the host would outlive the window it serves by up to six hours (`pnpm host` in a terminal shows it)
    this.timer.unref?.()
  }

  /**
   * Turns the periodic check on or off; turning it on looks at once, as an answer of "nothing yet" from a control flipped a
   * second ago reads as broken
   */
  async setAuto(enabled: boolean): Promise<UpdateStatus> {
    if (this.status.auto === enabled) return this.current()
    this.status = { ...this.status, auto: enabled }
    this.deps.writeAuto(enabled)
    if (!enabled) {
      this.stopTimer()
      this.emit()
      return this.current()
    }
    this.startTimer()
    return this.check(true)
  }

  /**
   * "Apply updates automatically when idle" on or off (#352). Turning it on with a newer version known installs it now, not at
   * the next check hours away; the install is safe while agents work (the keeper and every host run from their own copies), and
   * applying it is the window's, once idle
   */
  setAutoApply(enabled: boolean): UpdateStatus {
    if (this.status.autoApply === enabled) return this.current()
    this.status = { ...this.status, autoApply: enabled }
    this.deps.writeAutoApply(enabled)
    this.emit()
    if (enabled) this.installIfAutomatic()
    else this.cancelRetry()
    return this.current()
  }

  /**
   * With `autoApply` on and a newer version known, installs it once, not over an install or a finished one. A failed install is
   * retried only on the backoff (#645): a check right after the failure starts no `npm i -g`, one after the delay does, whether
   * the retry timer or Check now brought it
   */
  private installIfAutomatic(): void {
    if (!this.status.autoApply || !this.status.newer || !this.status.latest) return
    if (!installsByItself(this.deps.build, this.deps.current)) return
    if (this.status.phase === 'idle') {
      void this.apply()
      return
    }
    if (this.status.phase !== 'failed') return
    if (this.retryDue()) void this.apply()
    else if (!this.retryTimer) this.scheduleRetry()
  }

  /**
   * A failed install may be retried once its backoff has passed, or at once for a release other than the one that failed: a new
   * version is a new situation and one attempt is cheap
   */
  private retryDue(): boolean {
    if (!this.retry || this.retry.version !== this.status.latest) return true
    return this.deps.now() - this.retry.at >= retryDelay(this.retry.failures)
  }

  private scheduleRetry(): void {
    this.cancelRetry()
    if (this.stopped || !this.retry || !this.status.autoApply || this.status.phase !== 'failed') return
    const delay = Math.max(0, retryDelay(this.retry.failures) - (this.deps.now() - this.retry.at))
    this.retryTimer = this.deps.schedule(() => {
      this.retryTimer = null
      if (this.stopped || !this.status.autoApply || this.status.phase !== 'failed' || !this.status.newer || !this.status.latest) return
      if (!installsByItself(this.deps.build, this.deps.current)) return
      void this.apply()
    }, delay)
  }

  private cancelRetry(): void {
    this.retryTimer?.()
    this.retryTimer = null
  }

  /**
   * Looks at the registry, or answers with what is known. `force` is the Check now button; without it this is the timer, which
   * takes the shorter deadline and records a failure without interrupting anyone
   */
  async check(force: boolean): Promise<UpdateStatus> {
    // A second caller joins the first: the button and the timer landing together would be two fetches racing to write one field
    if (this.stopped) return this.current()
    if (this.installing) return this.withInstallTarget(this.current())
    if (this.inFlight) return this.withInstallTarget(await this.inFlight)
    /*
     * With automatic checking off nothing reaches the network unless a person asked: this guard makes the setting real, as the UI's
     * startup call would otherwise go to the registry whatever the checkbox said
     */
    if (!force && !this.status.auto) return this.current()
    // Not yet due: the answer already known, so opening the window sends no request each time
    if (!force && this.status.checkedAt !== null && !this.isDue()) return this.current()
    // An install outranks a check: overwriting `updating` with `checking` erases the only sign that anything is happening
    if (this.status.phase === 'updating' || this.status.phase === 'waiting_for_npm') return this.current()

    /*
     * Refreshing version metadata must not dismiss an install failure or "restart to finish". A host waiting to be restarted still
     * asks (#2130), as it may stay up for days and a later release would never be seen; the one it installed is never offered again
     * (`runCheck`), as the running process is still the old one and would count it newer
     */
    const kept = this.status.phase === 'failed' || this.status.phase === 'restart_required' ? { phase: this.status.phase, error: this.status.error } : null
    if (!kept) this.status = { ...this.status, phase: 'checking' }
    this.emit()
    this.inFlight = this.runCheck(force, kept)
    let found: UpdateStatus
    try {
      found = await this.inFlight
    } finally {
      this.inFlight = null
    }
    return this.withInstallTarget(found)
  }

  /**
   * `found`, or while an install runs its answer once its target is settled (#2131): during its registry lookup the status still
   * names the release waiting, which a check would report as available. Not awaited inside `runCheck`, which the install waits
   * for
   */
  private withInstallTarget(found: UpdateStatus): Promise<UpdateStatus> {
    const applying = this.applying
    return this.installing && applying ? applying.then(() => this.current()) : Promise.resolve(found)
  }

  private async runCheck(force: boolean, kept: Pick<UpdateStatus, 'phase' | 'error'> | null): Promise<UpdateStatus> {
    const res = await this.deps.fetchLatest(force ? FORCED_TIMEOUT_MS : SCHEDULED_TIMEOUT_MS)
    // An install may have started while this older check was waiting; its fresh lookup owns the target
    if (this.stopped || this.installing) return this.current()
    if (!res.ok) {
      /* A failed check keeps the last good answer: dropping `latest` would make a laptop that went offline look just told it is up to date */
      this.status = { ...this.status, phase: kept ? kept.phase : 'idle', error: kept ? kept.error : res.reason }
      this.emit()
      return this.current()
    }
    const latest = res.version
    /*
     * Nothing past the release installed and waiting: "restart to finish" stays, never an offer of what is installed; a failed
     * install of a later one stays failed with its error and retry, and the time it was seen is not renewed (#2131)
     */
    if (!this.passesInstalled(latest)) {
      this.status = kept?.phase === 'failed' ? { ...this.status, phase: 'failed', error: kept.error } : { ...this.waitingStatus(), checkedAt: this.deps.now() }
      this.emit()
      return this.current()
    }
    /*
     * A failure stays with the release that failed (#2282): one past it is a new offer and, with `autoApply` on, installed at once
     * (`retryDue`); the old error under it would name a version nobody is installing
     */
    const failed = this.retry?.version
    const failure = kept?.phase === 'failed' && !(failed && isNewerVersion(latest, failed)) ? kept : null
    this.status = {
      ...this.status,
      latest,
      newer: isNewerVersion(latest, this.status.current),
      phase: failure ? 'failed' : 'idle',
      error: failure?.error ?? null,
      checkedAt: this.deps.now(),
    }
    this.emit()
    this.installIfAutomatic()
    return this.current()
  }

  /**
   * Installs the newer version and says so; does not restart the app, which is the window's step (#352). Answers once the target
   * is settled (after the fresh lookup: at most the forced deadline, plus an older check it waits for; when `npm i -g` is about
   * to start, or when the registry shows nothing newer), not when the install is done: `npm i -g` regularly outlasts the RPC
   * deadline, and the rest arrives as `update_status` events. With nothing newer known it refreshes first (#645), as the stored
   * answer may be hours old or absent with automatic checks off; "up to date" is a result (`idle`, no error), never `failed`,
   * since a recorded refusal stayed on the line through every later check. While a release waits to be restarted into, it
   * installs only one past it (#2130), replacing the waiting build
   */
  apply(): Promise<UpdateStatus> {
    if (this.stopped) return Promise.resolve(this.current())
    if (this.installing) return this.applying ? this.applying.then(() => this.current()) : Promise.resolve(this.current())
    this.installing = true
    this.cancelRetry()
    const known = this.status.newer && this.status.latest && this.passesInstalled(this.status.latest) ? this.status.latest : null
    this.status = { ...this.status, phase: known ? 'updating' : 'checking', error: null }
    this.emit()
    this.applying = new Promise((settled) => void this.runApply(known, settled))
    return this.applying
  }

  private async runApply(known: string | null, settled: (status: UpdateStatus) => void): Promise<void> {
    let version = known
    let packageInstalled = false
    let answered = false
    const answer = () => {
      if (answered) return
      answered = true
      settled(this.current())
    }
    const copy = this.deps.installedCopy()
    try {
      // Finish an older check first, including one auto-apply started inside; the install stays busy throughout so a check or click
      // cannot replace its target
      await this.inFlight
      await this.following
      if (this.stopped) return
      const age = this.status.checkedAt === null ? Infinity : this.deps.now() - this.status.checkedAt
      if (version === null || age < 0 || age >= INSTALL_CHECK_MAX_AGE_MS) {
        const fresh = await this.deps.fetchLatest(FORCED_TIMEOUT_MS)
        if (this.stopped) return
        if (fresh.ok) {
          const now = this.deps.now()
          const storedAge = this.status.checkedAt === null ? Infinity : now - this.status.checkedAt
          const keepStored = version !== null && storedAge >= 0 && storedAge < STORED_RELEASE_MAX_AGE_MS && isNewerVersion(version, fresh.version)
          const target: string = keepStored && version !== null ? version : fresh.version
          version = target
          // Keeping an earlier observation must not renew it indefinitely across failed installs
          this.status = { ...this.status, latest: target, newer: isNewerVersion(target, this.status.current), checkedAt: keepStored ? this.status.checkedAt : now }
          if (!this.passesInstalled(target)) {
            this.status = { ...this.waitingStatus(), checkedAt: this.status.checkedAt }
            return
          }
          if (!this.status.newer) {
            this.status = { ...this.status, phase: 'idle', error: null }
            return
          }
        } else if (version === null) {
          // Nothing stored to fall back on: the answer of a failed check, and over a waiting release its own notice (a local build kept)
          // stays beside why nothing was looked up (#2131)
          const notice = this.installed?.error
          this.status = this.installed ? { ...this.waitingStatus(), error: notice ? `${fresh.reason}. ${notice}` : fresh.reason } : { ...this.status, phase: 'idle', error: fresh.reason }
          return
        } else {
          this.status = { ...this.status, error: `Could not refresh latest (${fresh.reason}); using previously checked ${version}.` }
        }
      }
      if (version === null) return // unreachable: a null target either refreshed above or returned
      this.status = { ...this.status, phase: 'updating' }
      this.emit()
      answer()
      /*
       * The exact version is pinned, not `@latest`: `centralu update` is decided by the installed launcher, which may be the copy
       * whose compare says every beta is the newest (#42); naming the version does not consult it
       */
      await this.installPackage(version)
      if (this.stopped) return
      packageInstalled = true
      /*
       * Refreshes the copy that gets launched, only if one exists (on macOS `centralu install` creates `/Applications/…`, not
       * for someone who never asked). Not over a maintainer's local build newer than the target (`keepsInstalledCopy`, #645:
       * `pnpm local-update` waiting for "Apply now" outranks its release); every other copy is replaced, a higher released one
       * too, and an unreadable version as well (a corrupt plist must not block updates). A kept local build still gets the
       * package updated. The launcher is the one npm just installed (`installCopy`), not `centralu` from PATH (a hub's shim,
       * #1736).
       */
      if (copy) {
        const copyVersion = this.deps.installedCopyVersion(copy)
        if (keepsInstalledCopy(version, copyVersion)) {
          const notice = `The local build ${copyVersion} at ${copy} is newer than ${version} and was kept.`
          this.status = { ...this.status, error: this.status.error ? `${this.status.error} ${notice}` : notice }
        } else {
          /*
           * `npm` resolves through the login-shell PATH that `env-path.ts` adds at startup: a GUI app inherits none. This
           * replaces the bundle we run out of (`swapInto` in `swap.mjs`: new beside, old renamed aside, new renamed in): macOS
           * keeps the process alive but between the renames paths inside the bundle do not resolve (#2117), so the end is
           * "restart". On Windows it renames the folder we run out of: NTFS allows it with the exe mapped while no process has
           * its working directory inside (measured on Windows 11; the app leaves it at start, `leave_app_folder`), and a later install sweeps
           * the old one
           */
          await this.installCopy()
        }
      }
      if (this.stopped) return
      this.status = { ...this.status, phase: 'restart_required' }
      this.installed = { version, error: this.status.error }
      this.retry = null
    } catch (e) {
      /*
       * Say which half failed: "npm i -g worked but the installed copy did not refresh" leaves the person launching the old app with
       * no sign, so it is named with the command that finishes it
       */
      if (this.stopped) return
      console.error(`[updates] install failed: ${failureLine(e)}`)
      const reason = errorMessage(e)
      const error = packageInstalled
        ? `npm installed ${version}, but the copy at ${copy} was not replaced (${reason}). Quit ${APP_NAME}, then run "${APP_SLUG} install" in a terminal.`
        : reason
      // Not waiting, also when npm took it: the copy is still the old build, so this is retried as any failure is
      this.status = { ...this.status, phase: 'failed', error }
      const target = version ?? this.status.latest ?? ''
      this.retry = { version: target, failures: this.retry?.version === target ? this.retry.failures + 1 : 1, at: this.deps.now() }
    } finally {
      this.installing = false
      this.applying = null
      if (!this.stopped) {
        this.emit()
        if (this.status.phase === 'failed') this.installIfAutomatic()
      }
      answer()
    }
  }

  /**
   * Brings the installed desktop copy up to this host's version (#1736), once per host start; main.ts calls it only for a host a
   * linked hub installed (`copyFollowsHost`). Only a copy older than this host, or unreadable or malformed, is replaced: after a
   * hub rollback the copy is newer and stays (a window of the same protocol works with the older host), as does a maintainer's
   * newer local build. The two steps of an install from the app (`runApply`): `npm i -g centralu@<this version>`, then the global
   * package's launcher `install` by path (`installCopy`). A global package at or above this version is not taken down: only its
   * `install` runs, after npm installs the package's own version again when its platform package is missing or at another
   * (#2282). No status changes; a failure is one stderr line, tried at the next start. Never beside an install from the app: one
   * running leaves this for the next start, and one asked for meanwhile waits for this
   */
  followHost(): Promise<void> {
    if (this.stopped || this.installing || this.following) return this.following ?? Promise.resolve()
    const copy = this.deps.installedCopy()
    if (!copy) return Promise.resolve()
    const was = this.deps.installedCopyVersion(copy)
    const to = this.deps.current
    if (atLeast(was, to)) return Promise.resolve()
    this.following = this.runFollow(copy, was, to).finally(() => {
      this.following = null
    })
    return this.following
  }

  private async runFollow(copy: string, was: string | null, to: string): Promise<void> {
    try {
      const global = await this.deps.globalPackage()
      if (!atLeast(global?.version ?? null, to)) await this.installGlobal(to)
      else if (global?.version && global.platform && global.platform.version !== global.version) await this.installGlobal(global.version)
      if (this.stopped) return
      await this.installCopy()
      console.error(`[updates] the installed copy at ${copy} was refreshed from the npm package at ${global?.version && atLeast(global.version, to) ? global.version : to} (it held ${was ?? 'an unreadable version'}; this host is ${to})`)
    } catch (e) {
      console.error(`[updates] could not bring the installed copy at ${copy} to ${to}: ${failureLine(e)}; tried again at the next host start`)
    }
  }

  private async installCopy(): Promise<void> {
    if (this.stopped) return
    const global = await this.deps.globalPackage()
    if (!global) throw new Error(`\`npm root -g\` did not lead to the ${APP_SLUG} launcher`)
    if (this.stopped) return
    await this.deps.run(this.deps.node, [global.launcher, 'install'])
  }

  /**
   * A just-published release can be visible from `latest` before its package reaches this machine's npm edge: `notarget`/ETARGET,
   * E404 on its own tarball while the packument lists it (#2279), or an exit 0 without this machine's platform package (#2282,
   * `installGlobal`). Only that condition waits, capped at ten minutes; credentials, disk and package errors fail at once.
   * `--prefer-online` makes npm revalidate its stale cache
   */
  private async installPackage(version: string): Promise<void> {
    const started = this.deps.now()
    const notice = this.status.error
    for (;;) {
      if (this.stopped) return
      try {
        await this.installGlobal(version)
        return
      } catch (err) {
        if (this.stopped) return
        if (!(err instanceof PlatformPackageMissing) && !npmHasNotServedVersion(err, version)) throw err
        // npm's own line, which `failureLine` still reads (stderr, exit code), is copied onto what ran out
        if (this.deps.now() - started >= NPM_RETRY_WINDOW_MS) throw Object.assign(new Error(`npm did not serve ${version} within ${NPM_RETRY_WINDOW_MS / 60_000} minutes: ${errorMessage(err)}`), err)
        this.status = { ...this.status, phase: 'waiting_for_npm', error: `Waiting for npm to serve ${version}${notice ? `. ${notice}` : ''}` }
        this.emit()
        await this.deps.wait(NPM_RETRY_DELAY_MS)
        if (this.stopped) return
        this.status = { ...this.status, phase: 'updating', error: notice }
        this.emit()
      }
    }
  }

  /**
   * `npm i -g centralu@<version>` and this machine's platform package with it (#2282): npm skips an optional dependency whose
   * tarball the edge does not serve yet and exits 0, leaving a launcher with no app and no host. That is the publish race of a
   * 404 on `centralu`'s tarball, so it throws `PlatformPackageMissing`, which the install waits out (`installPackage`). A global
   * package npm root does not lead to is left to `installCopy`, which says so
   */
  private async installGlobal(version: string): Promise<void> {
    await this.deps.run('npm', ['i', '-g', '--prefer-online', `${APP_SLUG}@${version}`])
    if (this.stopped) return
    const platform = (await this.deps.globalPackage())?.platform
    if (platform && platform.version !== version) throw new PlatformPackageMissing(`npm installed ${APP_SLUG} ${version} without ${platform.name}@${version}`)
  }

  private passesInstalled(version: string): boolean {
    return !this.installed || isNewerVersion(version, this.installed.version)
  }

  private waitingStatus(): UpdateStatus {
    const w = this.installed
    if (!w) return this.current()
    return { ...this.status, phase: 'restart_required', latest: w.version, newer: isNewerVersion(w.version, this.status.current), error: w.error }
  }

  private isDue(): boolean {
    return this.deps.now() - (this.status.checkedAt ?? 0) >= CHECK_INTERVAL_MS
  }

  private emit(): void {
    this.publish(this.current())
  }
}

/**
 * The service of the host: the real registry, `npm i -g`, global package and installed copy (`UpdateMachine`), named only here;
 * a bare `new UpdateService` reaches none of them (#2299)
 */
export function realUpdateService(publish: (status: UpdateStatus) => void, options: UpdateServiceOptions = {}): UpdateService {
  return new UpdateService(publish, {
    ...options,
    fetchLatest: fetchLatestFromRegistry,
    run: runCommand,
    installedCopy: () => existingCopy(installedCopyPath()),
    installedCopyVersion: (copy) => readInstalledCopyVersion(copy),
    globalPackage: npmGlobalPackage,
  })
}

class PlatformPackageMissing extends Error {}

/**
 * ETARGET by npm's last line only, as a warning above an unrelated error may name it; the tarball's 404 anywhere in stderr, as
 * npm's last line under it never names the URL
 */
function npmHasNotServedVersion(err: unknown, version: string): boolean {
  const tarball = `/${APP_SLUG}/-/${APP_SLUG}-${version}.tgz`.replace(/[.+]/g, '\\$&')
  return /\bETARGET\b|\bnotarget\b/i.test(errorMessage(err)) || new RegExp(`\\b404 Not Found - GET \\S+${tarball}(?!\\S)`, 'i').test(stderrOf(err))
}

function retryDelay(failures: number): number {
  return AUTO_RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), AUTO_RETRY_DELAYS_MS.length) - 1] ?? CHECK_INTERVAL_MS
}
