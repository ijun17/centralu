import type { ToolDescriptor } from '@cc/protocol'
import { rpcError } from '../../rpc-error.js'
import { runProgram, runsAntigravity } from '../../os.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { AGY_CAPABILITIES } from './capabilities.js'
import type { ToolLaunch } from '../../tool-launch.js'
import { findAgy } from './install.js'
import { STDERR } from './stream.js'
import { AGY_SURFACE } from './surface.js'

const DESCRIPTOR: ToolDescriptor = {
  name: 'agy',
  label: 'Antigravity',
  mark: 'A',
  install: 'curl -fsSL https://antigravity.google/install.sh | bash',
  login: 'agy',
}

/** `agy` is a 190 MB Go binary and the login check starts it: one answer is reused this long, as Cursor's `agent status` is */
const CHECK_FOR_MS = 60_000

/**
 * Whether `agy` is logged in is asked of the CLI itself and never of its files (the login is the person's, #59). `-p /usage`
 * is a read-only command that runs no turn and costs no quota (measured, §1.7); without a login it answers within a second
 * on stderr "authentication required" and exits 1. It starts in a session of its own (`detached`), so it has no terminal to
 * take an OAuth code from, and nothing to wait for.
 */
export type RunAgy = (command: string, args: string[], detached: boolean) => Promise<{ stdout: string; stderr: string }>

const runAgy: RunAgy = (command, args, detached) => runProgram(command, args, { timeoutMs: 20_000, detached })

export type AgyDeps = { find: () => ToolLaunch | null; run: RunAgy; supported: () => boolean }

const realDeps: AgyDeps = { find: () => findAgy(), run: runAgy, supported: () => runsAntigravity() }

export class AgyAdapter implements AgentAdapter {
  readonly tool = 'agy'
  readonly descriptor = DESCRIPTOR
  readonly capabilities = AGY_CAPABILITIES
  readonly surface = AGY_SURFACE

  constructor(private readonly deps: AgyDeps = realDeps) {}

  private version: { at: number; value: string | null } | null = null
  private status: { at: number; result: DetectResult } | null = null

  async installedVersion(): Promise<string | null> {
    const l = this.deps.find()
    if (!l) return null
    if (this.version && Date.now() - this.version.at < CHECK_FOR_MS) return this.version.value
    const value = (await this.deps.run(l.command, [...l.args, '--version'], false)).stdout.trim() || null
    this.version = { at: Date.now(), value }
    return value
  }

  async detect(): Promise<DetectResult> {
    const tool = DESCRIPTOR.name
    if (!this.deps.supported()) return { tool, installed: false, loggedIn: false, detail: 'Antigravity is not available on Windows yet' }
    if (this.status && Date.now() - this.status.at < CHECK_FOR_MS) return this.status.result
    const l = this.deps.find()
    let result: DetectResult
    if (!l) {
      result = { tool, installed: false, loggedIn: false, detail: 'Antigravity CLI not found (install it from https://antigravity.google/cli)' }
    } else {
      const v = await this.installedVersion()
      const out = await this.deps.run(l.command, [...l.args, '-p', '/usage', '--output-format', 'json'], true)
      const ok = !STDERR.loggedOut.test(`${out.stdout}
${out.stderr}`)
      result = { tool, installed: true, loggedIn: ok, detail: `agy${v ? ` ${v}` : ''}${ok ? '' : ' · login required'}` }
    }
    this.status = { at: Date.now(), result }
    return result
  }

  /** The session is wired in the next change (#59 part 2): until then the tool is listed and detected, and cannot start */
  async createSession(_opts: CreateSessionOpts, _emit: EventSink): Promise<SessionHandle> {
    throw rpcError('Antigravity sessions are not available yet.', 'internal')
  }
}
