import { rpcError } from '../../rpc-error.js'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import type { AdapterSurface } from '../contract/surface.js'
import { STOP_CONFIRM_MS } from '../core/ledger.js'
import { spawnLocalAgent } from '../local-process.js'
import { AGY_CAPABILITIES } from './capabilities.js'
import { AgySession, readAgyDenyRules, type AgyFind, type AgyHostDeps } from './session.js'
import type { ToolDescriptor } from '@cc/protocol'

/**
 * The Antigravity (`agy`) adapter: the one registration point of the session (docs/plans/antigravity-adapter.md). It names
 * nothing of detection, login or packaging: the profile brings those (`AgyProfile`), and the host brings the gate route and
 * the folders (`AgyHostDeps`). `createSession` returns a `CoreSession` over the `agy` wire.
 *
 * To register it: `new AgyAdapter(profile, host)` in `registry.ts`, with `host.gates` reading the host's `FrontDoorGates`
 * (built after the adapters in `main.ts`, hence the function).
 */

export type AgyProfile = {
  readonly descriptor: ToolDescriptor
  readonly surface?: AdapterSurface
  detect(): Promise<DetectResult>
  installedVersion(): Promise<string | null>
  /** Where `agy` is, asked for every new process; null: not installed */
  find: AgyFind
}

export class AgyAdapter implements AgentAdapter {
  readonly tool = 'agy'
  readonly capabilities = AGY_CAPABILITIES

  constructor(
    private readonly profile: AgyProfile,
    private readonly host: AgyHostDeps,
    private readonly spawn: (spec: AgentSpawnSpec) => AgentProcess = spawnLocalAgent,
    private readonly stopConfirmMs = STOP_CONFIRM_MS,
  ) {}

  get descriptor() {
    return this.profile.descriptor
  }

  get surface() {
    return this.profile.surface
  }

  detect() {
    return this.profile.detect()
  }

  installedVersion() {
    return this.profile.installedVersion()
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const label = this.profile.descriptor.label
    // Asked once here so a missing install is the error of the start, not of the first input
    if (!(await this.profile.find())) throw rpcError(`${label} is not installed. ${this.profile.descriptor.install}`, 'tool_not_installed')
    const denyRules = await readAgyDenyRules(this.host)
    const source = opts.processSource
    const session = new AgySession(
      opts,
      emit,
      { label, host: this.host, find: this.profile.find, start: { spawn: this.spawn, ...(source ? { source } : {}) }, stopConfirmMs: this.stopConfirmMs },
      denyRules,
    )
    try {
      await session.ready
    } catch (err) {
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}
