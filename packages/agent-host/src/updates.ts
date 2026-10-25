import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, APP_SLUG, APP_VERSION, isNewerVersion, keepsInstalledCopy, type UpdateStatus } from '@cc/protocol'
import { HOST_PLATFORM, installedCopyPath, installedCopyVersionSource, type Platform } from './os.js'
import { resolveCommand, type ToolLaunch } from './tool-launch.js'

/**
 * The in-app update check (issue #43).
 *
 * **Why this runs here and not in the launcher.** The launcher already knows how to
 * ask the registry and how to install — but the copy that runs is the one already on
 * the user's machine, and beta.1's copy compares versions wrong (#42). No fix can
 * reach it retroactively: the broken check is what would have to notice the fix. A
 * check that runs in the host ships *with the app*, so it is never older than the app
 * it is checking, and it bypasses every stale launcher on the way.
 *
 * **Notify; install when asked or allowed.** The check is read-only and its failures are swallowed;
 * replacing the running program is not, so it happens by a click, or by itself with `autoApply` on (#352), which is part
 * of Settings' "Automatic updates" and on for a person who never chose (owner decision 2026-10-20, update-switches.ts). Either way the host stops at `restart_required`: relaunching into the new build is
 * the window's step ("Apply now"), because only the window knows whether someone is typing,
 * and the keeper's switch afterwards is what keeps every running turn.
 */

/** The registry is the update channel — no server of ours, no signing keys (same as the launcher) */
const REGISTRY_URL = `https://registry.npmjs.org/${APP_SLUG}/latest`

/**
 * How often to look again while the app is running.
 *
 * Six hours for background polling; explicit checks and installs refresh sooner (#635).
 * "Once at startup" is not enough, because
 * this app is meant to be left open for days watching agents work, and a window that
 * has been up since Monday would never hear about Wednesday's release. Six hours is at
 * most four requests a day and still surfaces a release within the working day it ships.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Two deadlines, because the two callers want opposite things.
 *
 * The scheduled check is background noise nobody asked for — it gives up quickly and
 * says nothing. The one behind "Check now" has a person waiting on an answer, so it
 * waits as long as the launcher's own `update` does before admitting defeat.
 */
const SCHEDULED_TIMEOUT_MS = 3_000
const FORCED_TIMEOUT_MS = 8_000
/** Reuse a check that just found the release, especially when it starts auto-apply. */
const INSTALL_CHECK_MAX_AGE_MS = 60_000
/** A recent observation may outpace an npm edge; older tags must yield to a rollback. */
const STORED_RELEASE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * How long "Apply updates automatically when idle" waits before trying a failed install again (#645).
 *
 * A network blip or an npm edge that has not caught up should not switch automatic installs off for
 * the host's life, which is what "retry at the next check" meant once checks stopped erasing a
 * failure (#636). Soon the first time, then a step back, then the check interval: a persistent cause
 * (EACCES, a full disk) costs one `npm i -g` per six hours, not one per focus. In memory only, like
 * the rest of this status — a new host starts over, which is also what fixes most causes.
 */
const AUTO_RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000]

/** `npm i -g` on a cold cache is slow, but not this slow — past here something is stuck */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** npm can publish the dist-tag before every registry edge has the tarball. Wait for propagation, not a person. */
const NPM_RETRY_DELAY_MS = 30_000
const NPM_RETRY_WINDOW_MS = 10 * 60 * 1000

/**
 * The registry's answer. Failure is returned as a value too — throwing would force the caller to
 * stop the app.
 */
export type LatestResult = { ok: true; version: string } | { ok: false; reason: string }

/** What a source tree's version carriers hold until a build stamps them (#1501, `scripts/app-version.mjs` PLACEHOLDER) */
export const UNSTAMPED_VERSION = '0.0.0-dev'

/**
 * Whether this build may install a release by itself (#1501 review): never a host run from source (`build` `dev`), nor
 * one whose version is the placeholder (a source tree, or a remote dev build's host bundle). Every release is newer than
 * `0.0.0-dev`, so a stored "Automatic updates" on would otherwise run `npm i -g centralu@<latest>` on the machine of
 * whoever runs `pnpm host` against their own data folder. The update line still shows the release; a click installs it.
 */
export function installsByItself(build: string | undefined, current: string): boolean {
  return build !== 'dev' && current !== UNSTAMPED_VERSION
}

/**
 * Whether this hub updates its linked machines by itself to its own version (#1508, `LinkDeps.autoUpdate`): with
 * "Automatic updates" on, not mid-swap, and only from a build that may install by itself (`installsByItself`). A dev
 * hub's machines would also refuse on their own (`channel('0.0.0-dev')` is `dev`), but this does not lean on that.
 */
export function hubUpdatesMachines(f: { build: string; current: string; autoApply: boolean; draining: boolean }): boolean {
  return installsByItself(f.build, f.current) && f.autoApply && !f.draining
}

/**
 * Seams, and why they exist.
 *
 * Two of them, both for the same reason: without them a test of this file reaches the
 * real registry and runs a real `npm i -g` on the machine running the suite. That is
 * not a test, it is a side effect. Everything else here is the real thing.
 */
export type UpdateDeps = {
  /**
   * The version this build is: `APP_VERSION` when not given. Tests give a release, since a source tree carries the
   * placeholder `0.0.0-dev` (#1501) and every release is newer than that
   */
  current?: string
  /** The bundled build id, `dev` for a host run from source (`BUILD`); it never installs by itself (`installsByItself`) */
  build?: string
  /** Ask the registry what `latest` points at */
  fetchLatest?: (timeoutMs: number) => Promise<LatestResult>
  /** Run a command to completion, rejecting with its stderr */
  run?: (file: string, args: string[]) => Promise<void>
  /** The copy `centralu install` made, when there is one (`installedCopyPath`) */
  installedCopy?: () => string | null
  /** The version that copy carries, when it can be read (`readInstalledCopyVersion`) */
  installedCopyVersion?: (copy: string) => string | null
  now?: () => number
  /** Test seam for the automatic retry timer: runs `fn` after `ms`, returns how to cancel it */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Where the persisted "check automatically" answer lives across restarts */
  readAuto?: () => boolean
  writeAuto?: (enabled: boolean) => void
  /** Where "Apply updates automatically when idle" lives across restarts (#352) */
  readAutoApply?: () => boolean
  writeAutoApply?: (enabled: boolean) => void
  /** Test seam for the bounded registry-propagation wait. */
  wait?: (ms: number) => Promise<void>
}

/** Where `centralu install` would have put the app on this platform: a platform module's answer (`os.ts`). */
export { installedCopyPath }

function existingInstalledCopy(): string | null {
  const path = installedCopyPath()
  return existsSync(path) ? path : null
}

/**
 * The version the installed copy carries, or null when there is none to read (#645).
 *
 * How to read it is the platform's answer (`installedCopyVersionSource`, `os.ts`): on macOS the
 * launcher's own `plutil` command, so the two never disagree about a copy. Unreadable is unknown,
 * and `keepsInstalledCopy` replaces a copy whose version is unknown or malformed.
 */
export function readInstalledCopyVersion(copy: string, platform: Platform = HOST_PLATFORM): string | null {
  const source = installedCopyVersionSource(copy, platform)
  if (!source) return null
  try {
    const text =
      source.kind === 'command'
        ? execFileSync(source.file, source.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true })
        : readFileSync(join(copy, source.name), 'utf8')
    return text.trim() || null
  } catch {
    return null
  }
}

/**
 * Ask the registry. **Never throws** — the caller is either a timer nobody asked for
 * or a screen that has to keep working offline.
 *
 * Reasons are kept apart rather than lumped into "failed", because they send the person
 * somewhere different: unreachable means look at the network, 404 means looking will not
 * help (renamed, or unpublished).
 */
async function fetchLatestFromRegistry(timeoutMs: number): Promise<LatestResult> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { ok: false, reason: `${APP_SLUG} is not on the registry` }
    if (!res.ok) return { ok: false, reason: `The registry answered ${res.status}` }
    const body: unknown = await res.json()
    const version = (body as { version?: unknown } | null)?.version
    return typeof version === 'string'
      ? { ok: true, version }
      : { ok: false, reason: 'The registry answered in an unexpected shape' }
  } catch {
    return { ok: false, reason: 'Could not reach the registry — check the network' }
  }
}

/**
 * The program and arguments that run `file args` without a shell.
 *
 * On Windows `npm` and `centralu` are batch files (Node's `npm.cmd`, and npm's shim
 * `centralu.cmd`). `execFile` without a shell does not find a bare `npm` at all (libuv tries
 * `.com` and `.exe` only: ENOENT, the "Update failed" of every Windows build up to
 * 0.1.0-beta.12), and given the `.cmd` by its path Node refuses it (EINVAL since
 * CVE-2024-27980). A shell would work, and the launcher's own `update` uses one, but
 * `tool-launch.ts` already reads a batch file for the program it starts, so the same is done
 * here and no argument passes through cmd.exe. Elsewhere this is `file args` unchanged.
 */
export function commandFor(
  file: string,
  args: string[],
  resolve: (file: string) => ToolLaunch = (f) => resolveCommand(f),
): { file: string; args: string[] } {
  const launch = resolve(file)
  return { file: launch.command, args: [...launch.args, ...args] }
}

/**
 * The line of a failed command's stderr that says why, which is worth more than "command
 * failed": EACCES on a system Node and "no such command" are different errands.
 *
 * npm puts its cause last, then ends every failure with where its log went, which says nothing
 * about why, so that line is passed over. The launcher (`centralu install`) puts its cause first
 * and what to do after it ("Windows would not replace … — Centralu is probably still running",
 * then "Quit it, then run the command again", which reads wrong inside the app).
 */
export function failureDetail(file: string, stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/complete log of this run/i.test(l))
  return (file === 'npm' ? lines.at(-1) : lines[0]) ?? null
}

export function runCommand(file: string, args: string[], resolve?: (file: string) => ToolLaunch): Promise<void> {
  const cmd = commandFor(file, args, resolve)
  return new Promise((done, reject) => {
    // windowsHide: npm and the launcher are console programs; no window for them, whatever console the host has
    execFile(cmd.file, cmd.args, { timeout: INSTALL_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return done()
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error(`${file} was not found on PATH (${err.message})`))
      }
      reject(new Error(failureDetail(file, String(stderr)) || err.message))
    })
  })
}

export class UpdateService {
  private status: UpdateStatus
  private stopped = false
  private installing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly deps: Required<UpdateDeps>
  /** One check at a time — the timer and the button can land together */
  private inFlight: Promise<UpdateStatus> | null = null
  /** The last failed install: which version, how many times in a row, and when (#645) */
  private retry: { version: string; failures: number; at: number } | null = null
  /** Cancels the automatic retry timer, while one is pending */
  private retryTimer: (() => void) | null = null

  constructor(
    private publish: (status: UpdateStatus) => void,
    deps: UpdateDeps = {},
  ) {
    this.deps = {
      current: deps.current ?? APP_VERSION,
      build: deps.build ?? '',
      fetchLatest: deps.fetchLatest ?? fetchLatestFromRegistry,
      run: deps.run ?? runCommand,
      installedCopy: deps.installedCopy ?? existingInstalledCopy,
      installedCopyVersion: deps.installedCopyVersion ?? ((copy) => readInstalledCopyVersion(copy)),
      now: deps.now ?? Date.now,
      schedule:
        deps.schedule ??
        ((fn, ms) => {
          const t = setTimeout(fn, ms)
          // A pending retry must not hold the process open, no more than the check timer does
          t.unref?.()
          return () => clearTimeout(t)
        }),
      // If no place to persist it is given, treat auto-update as on — the same default that main.ts
      // passes in.
      readAuto: deps.readAuto ?? (() => true),
      writeAuto: deps.writeAuto ?? (() => {}),
      // Off when nothing is given (tests); the host passes the stored switch, on unless turned off (update-switches.ts)
      readAutoApply: deps.readAutoApply ?? (() => false),
      writeAutoApply: deps.writeAutoApply ?? (() => {}),
      wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    }
    this.status = {
      /*
       * The honest source for "which build is this".
       *
       * `APP_VERSION` is what the app was compiled from: the version a release stamped
       * into the build with the npm packages that carry it (#1501, `tooling/brand.test.ts`),
       * or the placeholder `0.0.0-dev` of a source tree. The workspace root's package.json
       * is not it — that one is private, has no version anyone installs, and would have
       * read `0.0.0` forever without ever being wrong enough to notice.
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
   * Start checking. Called once, at host start.
   *
   * The first check goes out immediately rather than waiting out the first interval,
   * because startup is the moment the answer is most likely to be stale — the app was
   * closed while releases happened.
   */
  start(): void {
    this.stopped = false
    if (!this.status.auto) return
    void this.check(false)
    this.startTimer()
  }

  /** Shutdown (including a host swap): no asynchronous continuation may start more work. */
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
    // Do not hold the process open for a version check. Without this the host outlives
    // the window it serves by up to six hours (`pnpm host` in a terminal shows it).
    this.timer.unref?.()
  }

  /**
   * Turn the periodic check on or off.
   *
   * Turning it on goes and looks straight away. Someone who just enabled this is asking
   * the question now, not in six hours — and an answer of "nothing yet" from a control
   * that was flipped a second ago reads as broken.
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
   * "Apply updates automatically when idle" on or off (#352).
   *
   * Turning it on with a newer version already known installs it now rather than at the next
   * check, hours away: the person just said they want updates applied without asking. The
   * install itself is safe while agents work (the keeper and every host run from their own
   * copies; the bundle on disk is what changes). Applying it is the window's, once idle.
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
   * With `autoApply` on and a newer version known, install it — once, not over an install or a
   * finished one. A failed install is tried again, but only on the backoff (#645): a check that
   * lands right after the failure does not start another `npm i -g`, and one after the delay does,
   * whether the retry timer or a person's Check now brought it.
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
   * A failed install may be retried once its backoff has passed — or at once for a release that
   * is not the one that failed: a new version is a new situation, and one attempt at it is cheap.
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
      // The timer is the backoff; by the time it fires, the attempt is due
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
   * Look at the registry, or answer with what we already know.
   *
   * `force` is the Check now button. Without it this is the timer, which is allowed to
   * be cheap and quiet — it takes the shorter deadline, and while it does record why it
   * failed, nothing about a background failure interrupts anyone.
   */
  async check(force: boolean): Promise<UpdateStatus> {
    // A second caller joins the first rather than opening its own request. The button
    // and the timer landing together used to be two fetches racing to write one field.
    if (this.stopped || this.installing) return this.current()
    if (this.inFlight) return this.inFlight
    /*
     * With automatic checking off, nothing reaches the network unless a person asked.
     *
     * This guard is the difference between a real setting and a decoration. The UI calls
     * this once at startup to learn where things stand, and without the guard that call
     * would go to the registry no matter what the checkbox said — the toggle would stop
     * the six-hourly requests and quietly keep the one at launch.
     */
    if (!force && !this.status.auto) return this.current()
    // If it is not yet time to ask, return the answer already known, so that opening the window
    // does not send out a request every time.
    if (!force && this.status.checkedAt !== null && !this.isDue()) return this.current()
    /*
     * An update outranks a check, during and after.
     *
     * `updating` is obvious — overwriting it with `checking` erases the only sign that
     * anything is happening. `restart_required` is the one that bites: the new version
     * is on disk and the running process is still the old one, so the scheduled check
     * six hours later would find the same "newer" it already installed and quietly
     * replace "restart to finish" with it. The person is then told to update again,
     * having already done so.
     */
    if (this.status.phase === 'updating' || this.status.phase === 'waiting_for_npm' || this.status.phase === 'restart_required') return this.current()

    // Refreshing version metadata must not dismiss an install failure (including while fetching).
    const failure = this.status.phase === 'failed' ? { error: this.status.error } : null
    if (!failure) this.status = { ...this.status, phase: 'checking' }
    this.emit()
    this.inFlight = this.runCheck(force, failure)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async runCheck(force: boolean, failure: Pick<UpdateStatus, 'error'> | null): Promise<UpdateStatus> {
    const res = await this.deps.fetchLatest(force ? FORCED_TIMEOUT_MS : SCHEDULED_TIMEOUT_MS)
    // An install may have started while this older check was waiting. Its fresh lookup owns the target.
    if (this.stopped || this.installing) return this.current()
    if (!res.ok) {
      /*
       * A failed check keeps the last good answer.
       *
       * Dropping `latest` on a failure would make a laptop that went offline look like
       * it had just been told it was up to date — the check would erase its own finding
       * every time the network blinked.
       */
      this.status = { ...this.status, phase: failure ? 'failed' : 'idle', error: failure ? failure.error : res.reason }
      this.emit()
      return this.current()
    }
    const latest = res.version
    this.status = {
      ...this.status,
      latest,
      newer: isNewerVersion(latest, this.status.current),
      phase: failure ? 'failed' : 'idle',
      error: failure?.error ?? null,
      checkedAt: this.deps.now(),
    }
    this.emit()
    // Asked for in advance (#352): a newer version found is installed without a click
    this.installIfAutomatic()
    return this.current()
  }

  /**
   * Install the newer version, then say so. **Does not restart the app** — that is the
   * window's step (#352).
   *
   * Answers once the target is settled: after the fresh lookup (at most the forced deadline, plus
   * an older check it waits for), when `npm i -g` is about to start, or when the registry shows
   * nothing newer. Not when the install is done — `npm i -g` regularly takes longer than the RPC
   * deadline, and a caller that has already given up cannot be told how it went; the rest of the
   * story arrives as `update_status` events.
   *
   * With nothing newer known it refreshes first rather than refusing (#645): the stored answer
   * may be hours old, or there may be none at all with automatic checks off. "Up to date" is then
   * a result (`idle`, no error), never `failed` — a refusal recorded as a failure stayed on the
   * line through every later check.
   */
  apply(): Promise<UpdateStatus> {
    if (this.stopped || this.installing || this.status.phase === 'restart_required') return Promise.resolve(this.current())
    this.installing = true
    // A person's click or the timer: either way this is the attempt, so no second timer waits behind it
    this.cancelRetry()
    const known = this.status.newer && this.status.latest ? this.status.latest : null
    // Nothing known yet: the line says "Checking…", not "Installing…", until the lookup answers
    this.status = { ...this.status, phase: known ? 'updating' : 'checking', error: null }
    this.emit()
    return new Promise((settled) => void this.runApply(known, settled))
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
      // Finish an older check before asking again, including when auto-apply started inside it.
      // Keep the install busy throughout: checks and another click must not replace its target.
      await this.inFlight
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
          // Keeping an earlier observation must not renew it indefinitely across failed installs.
          this.status = { ...this.status, latest: target, newer: isNewerVersion(target, this.status.current), checkedAt: keepStored ? this.status.checkedAt : now }
          if (!this.status.newer) {
            this.status = { ...this.status, phase: 'idle', error: null }
            return
          }
        } else if (version === null) {
          // Nothing stored to fall back on: the same answer as a failed check, and as little lasting
          this.status = { ...this.status, phase: 'idle', error: fresh.reason }
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
       * **Pin the exact version instead of asking for `@latest`.**
       *
       * `centralu update` would do all of this in one command — and would refuse to,
       * because the launcher doing the deciding is the installed one, and the installed
       * one may be the copy whose compare says every beta is already the newest (#42).
       * Naming the version we found does not consult it.
       */
      await this.installPackage(version)
      if (this.stopped) return
      packageInstalled = true
      /*
       * Refresh the copy that gets launched.
       *
       * Only if one exists: on macOS `centralu install` *creates* `/Applications/…`, and
       * putting an app there is not something to do to someone who never asked. By this
       * point the launcher on disk is the new one, so running it is safe — its `install`
       * keeps a newer local build (#645), the same rule as here.
       *
       * And not over a maintainer's local build newer than the target (#645, `keepsInstalledCopy`):
       * one (`pnpm local-update`) waiting in /Applications for "Apply now" outranks the release it
       * was cut from, and replacing it would undo it. Every other copy is replaced, a higher
       * released one too: npm is the source of truth for releases, and one pulled from `latest`
       * must not survive in /Applications to be offered by "Apply now". An unreadable or malformed
       * version is replaced as well, so a corrupt plist cannot block updates. When a local build is
       * kept the package is still updated — the launcher and `centralu serve` come from it — and
       * the notice says what was kept; the window's own bundle check offers to apply the copy.
       *
       * `centralu` resolves through PATH, which the host augments from the login shell at
       * startup (`env-path.ts`) precisely because a GUI app does not inherit one.
       *
       * **This deletes and re-creates the bundle we are running out of** (`rmSync` then
       * `ditto`, inside `centralu install`). macOS keeps a running process alive through
       * that — the launcher has always done exactly this to a running app — but there is a
       * gap of a second or two where paths inside the bundle do not resolve, which is one
       * more reason the honest end of this is "restart" and not "carry on".
       *
       * **On Windows it renames the folder we are running out of** (`Centralu` aside to
       * `Centralu.old-<time>`, then `Centralu.new` into its place). NTFS allows that with the
       * exe and the host's native modules mapped, as long as no process has its working
       * directory inside (measured on Windows 11, 2026-10-08), which the app sees to at start
       * (`leave_app_folder` in `src-tauri/src/lib.rs`). The running app keeps the old files
       * it has open; the next start runs the new folder. The old one cannot be deleted while
       * it runs and is left for the next install to sweep.
       */
      if (copy) {
        const copyVersion = this.deps.installedCopyVersion(copy)
        if (keepsInstalledCopy(version, copyVersion)) {
          const notice = `The local build ${copyVersion} at ${copy} is newer than ${version} and was kept.`
          this.status = { ...this.status, error: this.status.error ? `${this.status.error} ${notice}` : notice }
        } else {
          await this.deps.run(APP_SLUG, ['install'])
        }
      }
      if (this.stopped) return
      this.status = { ...this.status, phase: 'restart_required' }
      this.retry = null
    } catch (e) {
      /*
       * Say which half failed. "npm i -g worked but the installed copy did not get
       * refreshed" leaves the person launching the old app forever with no sign of it, and
       * that is the outcome most worth naming, with the one command that finishes it.
       */
      if (this.stopped) return
      const reason = (e as Error).message
      const error = packageInstalled
        ? `npm installed ${version}, but the copy at ${copy} was not replaced (${reason}). Quit ${APP_NAME}, then run "${APP_SLUG} install" in a terminal.`
        : reason
      this.status = { ...this.status, phase: 'failed', error }
      // Counted per target: a release that is not the one that failed starts its own count
      const target = version ?? this.status.latest ?? ''
      this.retry = { version: target, failures: this.retry?.version === target ? this.retry.failures + 1 : 1, at: this.deps.now() }
    } finally {
      this.installing = false
      if (!this.stopped) {
        this.emit()
        // Asked for in advance (#352): a failure is tried again on the backoff, not left for good (#645)
        if (this.status.phase === 'failed') this.installIfAutomatic()
      }
      answer()
    }
  }

  /**
   * A just-published release can be visible from `latest` before its package is on the npm edge
   * this machine reaches. `notarget`/ETARGET are that narrow condition; credentials, disk and
   * package errors still fail immediately. The ten minute cap makes this a wait with an end, not
   * a hidden retry loop. `--prefer-online` makes npm revalidate instead of trusting its stale cache.
   */
  private async installPackage(version: string): Promise<void> {
    const started = this.deps.now()
    const notice = this.status.error
    for (;;) {
      if (this.stopped) return
      try {
        await this.deps.run('npm', ['i', '-g', '--prefer-online', `${APP_SLUG}@${version}`])
        return
      } catch (err) {
        if (this.stopped) return
        if (!npmHasNotServedVersion(err) || this.deps.now() - started >= NPM_RETRY_WINDOW_MS) throw err
        this.status = { ...this.status, phase: 'waiting_for_npm', error: `Waiting for npm to serve ${version}${notice ? `. ${notice}` : ''}` }
        this.emit()
        await this.deps.wait(NPM_RETRY_DELAY_MS)
        if (this.stopped) return
        this.status = { ...this.status, phase: 'updating', error: notice }
        this.emit()
      }
    }
  }

  /** The scheduled check is due; a `force: false` caller in between reuses the last answer */
  private isDue(): boolean {
    return this.deps.now() - (this.status.checkedAt ?? 0) >= CHECK_INTERVAL_MS
  }

  private emit(): void {
    this.publish(this.current())
  }
}

function npmHasNotServedVersion(err: unknown): boolean {
  return /(?:\bETARGET\b|\bnotarget\b)/i.test(err instanceof Error ? err.message : String(err))
}

/** The wait before the n-th retry of a failed automatic install: the ladder, then its last step forever */
function retryDelay(failures: number): number {
  return AUTO_RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), AUTO_RETRY_DELAYS_MS.length) - 1]!
}
