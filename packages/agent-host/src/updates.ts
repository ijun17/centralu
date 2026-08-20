import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_NAME, APP_SLUG, APP_VERSION, isNewerVersion, type UpdateStatus } from '@cc/protocol'

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
 * **Notify, never apply.** The check is read-only and its failures are swallowed;
 * replacing the running program is not, so it happens only when someone asks. And even
 * then the app does not restart itself — `restart_required` is where this stops.
 */

/** The registry is the update channel — no server of ours, no signing keys (same as the launcher) */
const REGISTRY_URL = `https://registry.npmjs.org/${APP_SLUG}/latest`

/**
 * How often to look again while the app is running.
 *
 * Six hours. Releases are days apart, so anything tighter is asking a question whose
 * answer cannot have changed — but "once at startup" is not enough either, because
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

/** `npm i -g` on a cold cache is slow, but not this slow — past here something is stuck */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** 레지스트리의 답. 실패도 값으로 돌려준다 — 던지면 부르는 쪽이 앱을 멈춰야 한다 */
export type LatestResult = { ok: true; version: string } | { ok: false; reason: string }

/**
 * Seams, and why they exist.
 *
 * Two of them, both for the same reason: without them a test of this file reaches the
 * real registry and runs a real `npm i -g` on the machine running the suite. That is
 * not a test, it is a side effect. Everything else here is the real thing.
 */
export type UpdateDeps = {
  /** Ask the registry what `latest` points at */
  fetchLatest?: (timeoutMs: number) => Promise<LatestResult>
  /** Run a command to completion, rejecting with its stderr */
  run?: (file: string, args: string[]) => Promise<void>
  now?: () => number
  /** Where the persisted "check automatically" answer lives across restarts */
  readAuto?: () => boolean
  writeAuto?: (enabled: boolean) => void
}

/**
 * Where `centralu install` would have put the app on this platform.
 *
 * These two paths are the launcher's (`packaging/npm/centralu/bin/centralu.mjs`), and
 * they are re-derived rather than imported for the same reason the version compare is:
 * the launcher is a published npm package, not a workspace dependency. They must stay
 * in step — if they drift, the symptom is that updating leaves the *old* app in
 * `/Applications` while npm holds the new one, and the person keeps launching the old
 * one with no sign that anything is wrong.
 */
function installedCopyPath(): string {
  return process.platform === 'darwin'
    ? `/Applications/${APP_NAME}.app`
    : join(homedir(), '.local/share/applications', `${APP_SLUG}.desktop`)
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

function runCommand(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: INSTALL_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) return resolve()
      // The last line of npm's own complaint is worth more than "command failed" —
      // EACCES on a system Node and "no such command" are different errands.
      const detail = String(stderr).trim().split('\n').filter(Boolean).pop()
      reject(new Error(detail || err.message))
    })
  })
}

export class UpdateService {
  private status: UpdateStatus
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly deps: Required<UpdateDeps>
  /** One check at a time — the timer and the button can land together */
  private inFlight: Promise<UpdateStatus> | null = null

  constructor(
    private publish: (status: UpdateStatus) => void,
    deps: UpdateDeps = {},
  ) {
    this.deps = {
      fetchLatest: deps.fetchLatest ?? fetchLatestFromRegistry,
      run: deps.run ?? runCommand,
      now: deps.now ?? Date.now,
      // 저장할 곳을 안 주면 켜져 있는 것으로 본다 — main.ts가 주는 것과 같은 기본값이다
      readAuto: deps.readAuto ?? (() => true),
      writeAuto: deps.writeAuto ?? (() => {}),
    }
    this.status = {
      /*
       * The honest source for "which build is this".
       *
       * `APP_VERSION` is what the app was compiled from, and `tooling/brand.test.ts`
       * fails the build if it disagrees with the npm packages that carry it. The
       * workspace root's package.json is not it — that one is private, has no version
       * anyone installs, and would have read `0.0.0` forever without ever being wrong
       * enough to notice.
       */
      current: APP_VERSION,
      latest: null,
      newer: false,
      auto: this.deps.readAuto(),
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
    if (!this.status.auto) return
    void this.check(false)
    this.startTimer()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private startTimer(): void {
    this.stop()
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
      this.stop()
      this.emit()
      return this.current()
    }
    this.startTimer()
    return this.check(true)
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
    // 아직 물어볼 때가 안 됐으면 알던 답을 준다 — 창을 열 때마다 요청이 나가지 않게
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
    if (this.status.phase === 'updating' || this.status.phase === 'restart_required') return this.current()

    this.status = { ...this.status, phase: 'checking' }
    this.emit()
    this.inFlight = this.runCheck(force)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async runCheck(force: boolean): Promise<UpdateStatus> {
    const res = await this.deps.fetchLatest(force ? FORCED_TIMEOUT_MS : SCHEDULED_TIMEOUT_MS)
    if (!res.ok) {
      /*
       * A failed check keeps the last good answer.
       *
       * Dropping `latest` on a failure would make a laptop that went offline look like
       * it had just been told it was up to date — the check would erase its own finding
       * every time the network blinked.
       */
      this.status = { ...this.status, phase: 'idle', error: res.reason }
      this.emit()
      return this.current()
    }
    this.status = {
      ...this.status,
      latest: res.version,
      newer: isNewerVersion(res.version, this.status.current),
      phase: 'idle',
      error: null,
      checkedAt: this.deps.now(),
    }
    this.emit()
    return this.current()
  }

  /**
   * Install the newer version, then say so. **Does not restart the app.**
   *
   * Returns the moment the work starts. `npm i -g` regularly takes longer than the RPC
   * deadline, and a caller that has already given up cannot be told how it went; the
   * rest of the story arrives as `update_status` events.
   */
  apply(): UpdateStatus {
    if (this.status.phase === 'updating') return this.current()
    const latest = this.status.latest
    if (!this.status.newer || !latest) {
      // Refusing out loud rather than shrugging: this can only be reached from a button
      // that should not have been on screen, and a silent no-op hides that it was.
      this.status = { ...this.status, phase: 'failed', error: 'There is no newer version to install' }
      this.emit()
      return this.current()
    }
    this.status = { ...this.status, phase: 'updating', error: null }
    this.emit()
    void this.runApply(latest)
    return this.current()
  }

  private async runApply(version: string): Promise<void> {
    try {
      /*
       * **Pin the exact version instead of asking for `@latest`.**
       *
       * `centralu update` would do all of this in one command — and would refuse to,
       * because the launcher doing the deciding is the installed one, and the installed
       * one may be the copy whose compare says every beta is already the newest (#42).
       * Naming the version we found does not consult it.
       */
      await this.deps.run('npm', ['i', '-g', `${APP_SLUG}@${version}`])
      /*
       * Refresh the copy that gets launched.
       *
       * Only if one exists: on macOS `centralu install` *creates* `/Applications/…`, and
       * putting an app there is not something to do to someone who never asked. By this
       * point the launcher on disk is the new one, so running it is safe — its `install`
       * has no version comparison in it at all.
       *
       * `centralu` resolves through PATH, which the host augments from the login shell at
       * startup (`env-path.ts`) precisely because a GUI app does not inherit one.
       *
       * **This deletes and re-creates the bundle we are running out of** (`rmSync` then
       * `ditto`, inside `centralu install`). macOS keeps a running process alive through
       * that — the launcher has always done exactly this to a running app — but there is a
       * gap of a second or two where paths inside the bundle do not resolve, which is one
       * more reason the honest end of this is "restart" and not "carry on".
       */
      if (existsSync(installedCopyPath())) await this.deps.run(APP_SLUG, ['install'])
      this.status = { ...this.status, phase: 'restart_required', error: null }
    } catch (e) {
      /*
       * Say which half failed. "npm i -g worked but the /Applications copy did not get
       * refreshed" leaves the user launching the old app forever with no sign of it, and
       * that is the outcome most worth naming.
       */
      this.status = { ...this.status, phase: 'failed', error: (e as Error).message }
    }
    this.emit()
  }

  /** The scheduled check is due; a `force: false` caller in between reuses the last answer */
  private isDue(): boolean {
    return this.deps.now() - (this.status.checkedAt ?? 0) >= CHECK_INTERVAL_MS
  }

  private emit(): void {
    this.publish(this.current())
  }
}
