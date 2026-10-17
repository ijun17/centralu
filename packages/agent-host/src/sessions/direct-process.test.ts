import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { alive, fakeAgentCli, goneWithin, helperPid, killLeftovers } from '../adapters/fake-agent-cli.test-helpers.js'
import { spawnLocalAgent, type LocalAgentProcess } from '../adapters/local-process.js'
import { AgentVersionService } from '../agent-versions.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * Putting a session to sleep (#568) and moving it to a newly installed CLI (#297) without a keeper, with real
 * processes. This is the only path on Windows, where there is no keeper, and the one `pnpm dev`, e2e and a debug app
 * take elsewhere. `sleep.test.ts` and `agent-versions-direct.test.ts` hold the rules with handles that stand for a
 * process; this is about what ending one reaches: the CLI and the helper it started (a language server, an MCP server)
 * are both gone, on Windows by `taskkill /T` or the sweep after the exit (`local-process.ts`).
 *
 * The adapter spawns the CLI as the Claude adapter does without a keeper (`spawnLocalAgent`), and on dispose closes
 * its stdin and signals it, as the SDK does.
 */

// Real processes: a node start costs seconds on a loaded machine, and every wait below is bounded on its own
vi.setConfig({ testTimeout: 30_000 * SLOW })
/** The sweep after an exit lists processes through PowerShell on Windows, which alone takes most of a second */
const GONE_MS = 5_000 * SLOW

class Handle implements SessionHandle {
  externalId: string | null
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    readonly process: LocalAgentProcess,
    readonly helper: number,
    version: string,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
    emit({ type: 'agent_version', sessionId, version })
  }
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    const exited = new Promise((r) => (this.process.exitCode !== null || this.process.signalCode !== null ? r(null) : this.process.once('exit', r)))
    this.process.stdin.end()
    this.process.kill('SIGTERM')
    await exited
  }
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  cli = '2.1.282'
  created: Handle[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async installedVersion() {
    return this.cli
  }
  async listExternalSessions() {
    return this.created.map((c) => ({ externalId: c.externalId!, title: 'x', updatedAt: Date.now() }))
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const p = spawnLocalAgent({ ...fakeAgentCli(), cwd: tmpdir(), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper, p.pid!)
    const h = new Handle(opts.sessionId, opts, emit, p, helper, this.cli)
    this.created.push(h)
    return h
  }
}

let store: Store
const started: number[] = []

beforeEach(() => {
  store = new Store()
})

afterEach(() => {
  store.close()
  killLeftovers(started)
})

/** A host without a keeper: no process source, the adapter starts its own processes. The version service as main.ts wires it */
function host() {
  const adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const ref: { svc?: AgentVersionService } = {}
  const mgr = new SessionManager(store, adapters, (e: NormalizedEvent) => ref.svc?.observe(e), undefined, tmpdir())
  const svc = new AgentVersionService({
    tools: () => [{ tool: 'claude', installedVersion: () => adapter.installedVersion() }],
    sessions: mgr,
    publish: () => {},
    quietMs: 0,
  })
  ref.svc = svc
  mgr.useVersionHint((tool) => svc.installedNow(tool))
  return { adapter, mgr, svc, rpc: createRpcHandler(mgr, adapters, { agentVersions: svc }) }
}

async function session(h: ReturnType<typeof host>): Promise<string> {
  const p = (await h.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await h.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  return s.id
}

describe('a session’s own process without a keeper, for real', () => {
  it('sleep ends the CLI and the helper it started; a message wakes it in a new process (#568)', async () => {
    const h = host()
    const s = await session(h)
    const first = h.adapter.created.at(-1)!
    first.emit({ type: 'turn_complete', sessionId: s })

    expect(await h.mgr.sleepSession(s)).toBe(true)
    expect(alive(first.process.pid!)).toBe(false)
    expect(await goneWithin(first.helper, GONE_MS)).toBe(true)
    expect(h.mgr.listSessions().find((x) => x.id === s)!.live).toBe(false)

    await h.mgr.send(s, 'still there?')
    expect(h.adapter.created).toHaveLength(2)
    const second = h.adapter.created.at(-1)!
    expect(second.opts.resumeExternalId).toBe(first.externalId)
    expect(alive(second.process.pid!) && alive(second.helper)).toBe(true)
    await h.mgr.disposeAll()
    expect(await goneWithin(second.helper, GONE_MS)).toBe(true)
  })

  it('a move to a newly installed CLI ends the old CLI and its helper, and runs a new one (#297)', async () => {
    const h = host()
    await h.svc.check(true)
    const s = await session(h)
    const first = h.adapter.created.at(-1)!
    first.emit({ type: 'turn_complete', sessionId: s })

    h.adapter.cli = '2.1.290'
    await h.svc.check(true)
    expect(await h.rpc('agents.applyVersions', {})).toEqual({ restarted: [s], busy: [] })
    expect(alive(first.process.pid!)).toBe(false)
    expect(await goneWithin(first.helper, GONE_MS)).toBe(true)

    expect(h.adapter.created).toHaveLength(2)
    const second = h.adapter.created.at(-1)!
    expect(alive(second.process.pid!) && alive(second.helper)).toBe(true)
    expect(h.mgr.listSessions().find((x) => x.id === s)!.agentVersion).toBe('2.1.290')
    await h.mgr.disposeAll()
    expect(await goneWithin(second.helper, GONE_MS)).toBe(true)
  })
})
