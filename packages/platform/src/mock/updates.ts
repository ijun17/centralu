import type { UpdateStatus } from '@cc/protocol/client'
import { APP_VERSION, isNewerVersion } from '@cc/protocol/client'
import type { UpdatePort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { Emit } from './event-bus.js'

/** App updates (issue #43), behind the `updates` port, and the agent's "Apply now" (#665) */
export class UpdatesMock {
  /**
   * For tests: the version the registry pretends to hold as `latest` (issue #43).
   * Null means it could not be reached — different from "this is the latest version."
   */
  registryVersion: string | null = null
  /** Records calls to the update status port, including forced checks. */
  updateChecks: boolean[] = []

  /** For tests: `npm i -g` fails (it is never actually run) */
  updateFails: string | null = null

  updateStatus: UpdateStatus = {
    current: APP_VERSION,
    latest: null,
    newer: false,
    auto: true,
    autoApply: false,
    phase: 'idle',
    error: null,
    checkedAt: null,
  }

  /**
   * App updates (issue #43).
   *
   * **Follows the same rules as the real thing.** Two in particular: the comparison uses
   * protocol's own (`isNewerVersion` — if the mock made up its own rule, a split between the
   * two would be invisible), and installing responds **before it finishes** and sends the rest
   * as events. It is also part of the contract here that `npm i -g` is not merely faked but
   * never actually run at all — a test must never touch the machine.
   *
   * Not mirrored: the host's backoff retry of a failed automatic install (#645). A test that sets
   * `updateFails` wants that failure to stay on screen, not to be tried again behind its back.
   */
  readonly updates: UpdatePort = {
    status: async (force = false) => {
      this.updateChecks.push(force)
      // Same as the real thing: if automatic checking is off, it asks nowhere until the person clicks
      if (!force && !this.updateStatus.auto) return { ...this.updateStatus }
      if (!force && this.updateStatus.checkedAt !== null) return { ...this.updateStatus }
      if (this.updateStatus.phase === 'updating' || this.updateStatus.phase === 'waiting_for_npm' || this.updateStatus.phase === 'restart_required') {
        return { ...this.updateStatus }
      }
      return this.runUpdateCheck()
    },
    setAuto: async (enabled: boolean) => {
      if (this.updateStatus.auto === enabled) return { ...this.updateStatus }
      this.setUpdateStatus({ auto: enabled })
      // Someone who just turned it on is asking right now — not six hours from now
      return enabled ? this.runUpdateCheck() : { ...this.updateStatus }
    },
    // Same as the real thing (#352): turning it on installs a newer version already known
    setAutoApply: async (enabled: boolean) => {
      if (this.updateStatus.autoApply === enabled) return { ...this.updateStatus }
      this.setUpdateStatus({ autoApply: enabled })
      if (enabled) this.installIfAutomatic()
      return { ...this.updateStatus }
    },
    apply: async () => this.installUpdate(),
    // An agent's "Apply now" (#665): the window's half, answered the way update-apply.ts in the host does for one window
    answerApply: async (a) => {
      this.applyAnswers.push(a)
      const waiting = this.applyWaits.get(a.requestId)
      if (!waiting) return { ticket: null }
      this.applyWaits.delete(a.requestId)
      const ticket = a.ready ? `ticket-${a.requestId}` : null
      waiting(ticket ? { ticket } : { error: a.reason ?? 'not ready' })
      return { ticket }
    },
    reportApply: async (r) => {
      this.applyReports.push(r)
      // "Started" is the last word before the relaunch; the outcome is what follows it
      if (r.started) return
      this.applyOutcomes.get(r.ticket)?.(r.error)
      this.applyOutcomes.delete(r.ticket)
    },
  }

  /** For tests (#665): what the window answered to an agent's "Apply now", and what it reported after the go */
  applyAnswers: { requestId: string; ready: boolean; reason?: string; version?: string }[] = []
  applyReports: { requestId: string; ticket: string; started?: boolean; error?: string }[] = []
  private applyWaits = new Map<string, (r: { ticket: string } | { error: string }) => void>()
  private applyOutcomes = new Map<string, (error: string | undefined) => void>()
  private applyRequests = 0

  /**
   * Scenario helper (#665): as if an agent called `update_centralu` with action "apply" and was allowed. The request
   * goes out as the host sends it; the window that answers ready is told to go. Resolves with what the tool would say:
   * the relaunch started, or why not.
   */
  async agentApply(): Promise<{ ok: true } | { ok: false; error: string }> {
    const requestId = `apply-${++this.applyRequests}`
    const answer = await new Promise<{ ticket: string } | { error: string }>((resolve) => {
      this.applyWaits.set(requestId, resolve)
      setTimeout(() => {
        if (this.applyWaits.delete(requestId)) resolve({ error: 'No Centralu window answered.' })
      }, 5_000)
      this.emit({ type: 'update_apply_request', requestId })
    })
    if ('error' in answer) return { ok: false, error: answer.error }
    const error = await new Promise<string | undefined>((resolve) => {
      this.applyOutcomes.set(answer.ticket, resolve)
      this.emit({ type: 'update_apply_go', requestId, ticket: answer.ticket })
    })
    return error ? { ok: false, error } : { ok: true }
  }

  private installIfAutomatic(): void {
    const u = this.updateStatus
    if (u.autoApply && u.newer && u.latest && u.phase === 'idle') void this.installUpdate()
  }

  private installUpdate(): UpdateStatus {
    if (this.updateStatus.phase === 'updating' || this.updateStatus.phase === 'waiting_for_npm' || this.updateStatus.phase === 'restart_required') return { ...this.updateStatus }
    // Nothing newer known: refresh before refusing (#645), as the host does. Up to date is a result, not a failure.
    const known = this.updateStatus.newer && this.updateStatus.latest ? this.updateStatus.latest : null
    // Same target refresh as UpdateService, without a network or an npm command.
    const age = this.updateStatus.checkedAt === null ? Infinity : this.clock.now() - this.updateStatus.checkedAt
    let error: string | null = null
    let target = known
    if (known === null || age < 0 || age >= 60_000) {
      const fresh = this.registryVersion
      if (fresh === null) {
        if (known === null) {
          this.setUpdateStatus({ phase: 'idle', error: 'Could not reach the registry — check the network' })
          return { ...this.updateStatus }
        }
        error = `Could not refresh latest; using previously checked ${known}.`
      } else {
        const keepStored = known !== null && age >= 0 && age < 3600_000 && isNewerVersion(known, fresh)
        target = keepStored ? known : fresh
        this.setUpdateStatus({ latest: target, newer: isNewerVersion(target, this.updateStatus.current), checkedAt: keepStored ? this.updateStatus.checkedAt : this.clock.now() })
        if (!this.updateStatus.newer) {
          this.setUpdateStatus({ phase: 'idle', error: null })
          return { ...this.updateStatus }
        }
      }
    }
    if (target === null) return { ...this.updateStatus } // unreachable: a null target refreshed or returned above
    this.setUpdateStatus({ phase: 'updating', error })
    /*
     * The end is announced **after** the response is given. Installing routinely exceeds
     * the RPC timeout, and the real thing behaves the same way, so "installing → please
     * restart" only ever arrives as an event.
     */
    setTimeout(() => {
      if (this.updateFails) this.setUpdateStatus({ phase: 'failed', error: this.updateFails })
      else this.setUpdateStatus({ phase: 'restart_required', error })
    }, 0)
    return { ...this.updateStatus }
  }
  private runUpdateCheck(): UpdateStatus {
    const failure = this.updateStatus.phase === 'failed' ? { error: this.updateStatus.error } : null
    if (this.registryVersion === null) {
      // Could not reach it — leaves what was found out last time untouched (the same rule as the real thing)
      this.setUpdateStatus({ phase: failure ? 'failed' : 'idle', error: failure ? failure.error : 'Could not reach the registry — check the network' })
      return { ...this.updateStatus }
    }
    const latest = this.registryVersion
    this.setUpdateStatus({
      latest,
      newer: isNewerVersion(latest, this.updateStatus.current),
      phase: failure ? 'failed' : 'idle',
      error: failure?.error ?? null,
      checkedAt: this.clock.now(),
    })
    this.installIfAutomatic()
    return { ...this.updateStatus }
  }

  private setUpdateStatus(patch: Partial<UpdateStatus>): void {
    this.updateStatus = { ...this.updateStatus, ...patch }
    this.emit({ type: 'update_status', status: { ...this.updateStatus } })
  }

  /** Scenario helper: makes it as if the registry got a new version (used from Playwright) */
  offerUpdate(version: string): void {
    this.registryVersion = version
    this.runUpdateCheck()
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
  ) {}
}
