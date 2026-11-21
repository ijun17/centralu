import type { UpdateStatus } from '@cc/protocol/client'
import { APP_VERSION, isNewerVersion } from '@cc/protocol/client'
import type { UpdatePort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { Emit } from './event-bus.js'

/** App updates (issue #43), behind the `updates` port, and the agent's "Apply now" (#665) */
export class UpdatesMock {
  /** The registry's `latest` (#43); null: unreachable, not "up to date" */
  registryVersion: string | null = null
  updateChecks: boolean[] = []

  /** `npm i -g` fails (it is never run) */
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
   * As the host (#43): protocol's `isNewerVersion`, and installing answers before it finishes, the rest as events; `npm
   * i -g` never runs. Not mirrored: the backoff retry of a failed automatic install (#645), so `updateFails` stays shown.
   */
  readonly updates: UpdatePort = {
    status: async (force = false) => {
      this.updateChecks.push(force)
      // With automatic checking off it asks nowhere until the person clicks
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
      // Turned on just now: ask now, not in six hours
      return enabled ? this.runUpdateCheck() : { ...this.updateStatus }
    },
    // Turning it on installs a newer version already known (#352)
    setAutoApply: async (enabled: boolean) => {
      if (this.updateStatus.autoApply === enabled) return { ...this.updateStatus }
      this.setUpdateStatus({ autoApply: enabled })
      if (enabled) this.installIfAutomatic()
      return { ...this.updateStatus }
    },
    apply: async () => this.installUpdate(),
    // The window's half of an agent's "Apply now" (#665), as update-apply.ts answers for one window
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
      if (r.started) return
      this.applyOutcomes.get(r.ticket)?.(r.error)
      this.applyOutcomes.delete(r.ticket)
    },
  }

  applyAnswers: { requestId: string; ready: boolean; reason?: string; version?: string }[] = []
  applyReports: { requestId: string; ticket: string; started?: boolean; error?: string }[] = []
  private applyWaits = new Map<string, (r: { ticket: string } | { error: string }) => void>()
  private applyOutcomes = new Map<string, (error: string | undefined) => void>()
  private applyRequests = 0

  /** As if an agent's allowed `update_centralu` "apply" (#665); resolves with what the tool would say */
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
    // As UpdateService, without a network or an npm command
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
    // After the response: installing routinely exceeds the RPC timeout, so the end only arrives as an event
    setTimeout(() => {
      if (this.updateFails) this.setUpdateStatus({ phase: 'failed', error: this.updateFails })
      else this.setUpdateStatus({ phase: 'restart_required', error })
    }, 0)
    return { ...this.updateStatus }
  }
  private runUpdateCheck(): UpdateStatus {
    const failure = this.updateStatus.phase === 'failed' ? { error: this.updateStatus.error } : null
    if (this.registryVersion === null) {
      // Unreachable: what was found last time stays
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

  offerUpdate(version: string): void {
    this.registryVersion = version
    this.runUpdateCheck()
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
  ) {}
}
