import type { ToolName } from '@cc/protocol'
import { rpcError } from '../../rpc-error.js'
import { waitForExit } from '../../timing.js'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, EventSink, ProcessSource, SessionHandle } from '../contract.js'
import { toolResultEvent } from '../tool-result.js'
import { spawnLocalAgent } from '../local-process.js'
import type { AcpProfile } from './profile.js'
import { frameRecorder } from '../frames/recorder.js'
import { AcpSession } from './session.js'

/** How long a Stop waits for the agent's `cancelled` before the person hears it has not taken effect (Claude's bound) */
const STOP_CONFIRM_MS = 10_000

/**
 * The generic ACP client adapter (docs/plans/acp-adapter.md): one agent process per session, spawned as a child of
 * this host. A tool's adapter is this class with its profile and its own `tool` name; nothing here names a tool.
 */
export abstract class AcpAdapter implements AgentAdapter {
  abstract readonly tool: ToolName

  constructor(
    protected readonly profile: AcpProfile,
    private readonly spawn: (spec: AgentSpawnSpec) => AgentProcess = spawnLocalAgent,
    private readonly stopConfirmMs = STOP_CONFIRM_MS,
  ) {}

  get descriptor() {
    return this.profile.descriptor
  }

  get capabilities() {
    return this.profile.capabilities
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
    const launch = await this.profile.launch()
    if (!launch) throw rpcError(`${label} is not installed. ${this.profile.descriptor.install}`, 'tool_not_installed')
    const recorder = frameRecorder(opts.sessionId)
    const spec = { command: launch.command, args: launch.args, cwd: opts.cwd, env: { ...process.env, ...launch.env } }
    const source = opts.processSource
    if (source?.adopt) await closeAdopted(source.adopt, opts.sessionId, emit)
    // Under the keeper the process is the keeper's child, which it sweeps with its tree if this host goes (§3.3)
    const proc = source ? source.spawn(spec) : this.spawn(spec)
    if (recorder) proc.once('exit', (code, signal) => recorder.exit(code, signal))
    const session = new AcpSession(opts, emit, {
      label,
      process: proc,
      version: () => this.profile.installedVersion(),
      stopConfirmMs: this.stopConfirmMs,
      ...(recorder ? { onFrame: recorder.frame } : {}),
    })
    try {
      await session.ready
    } catch (err) {
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}

/**
 * A process the previous host left running (a swap or a crash under the keeper, §4.4): this adapter does not take over a
 * running ACP connection yet, so it is ended with its tree, the tool calls it left open are closed as failed (their cards
 * would spin forever), and the conversation is opened again in a new process with `session/load`.
 */
/** A killed process is gone in well under this; the bound only keeps a stuck one from holding the session's start */
const ADOPTED_EXIT_MS = 5_000

/** Ends the process a previous host left, and waits for it to be gone: the new one loads the same conversation */
async function closeAdopted(adopt: NonNullable<ProcessSource['adopt']>, sessionId: string, emit: EventSink): Promise<void> {
  adopt.process.kill('SIGKILL')
  await waitForExit(adopt.process, ADOPTED_EXIT_MS)
  for (const call of adopt.openCalls) emit(toolResultEvent(sessionId, call.callId, false, '', 'Centralu restarted while this call ran; it was stopped'))
}
