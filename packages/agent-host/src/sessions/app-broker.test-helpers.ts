import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, AppToolResult, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { storePermissionBook } from '../app-permission-book.js'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps, type RuntimeTiming } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP, type PlantKit } from './session-apps.test-helpers.js'

/**
 * A test world that follows an app's mediation (M4 D) all the way through the manager — a real
 * manager, runtime, app process (the fixture's `mediation`) and run record. Only the adapter is
 * fake: it records the options it received, and emits the agent's answer however the test
 * dictates.
 *
 * (A test-only file. Planting app folders is handed off to test files, the same way
 * `session-apps.test-helpers.ts` does.)
 */

export class FakeHandle implements SessionHandle {
  readonly externalId: string
  readonly sent: string[] = []
  readonly answered: { requestId: string; decision: string }[] = []
  interrupted = false
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    private onSend: (h: FakeHandle, text: string) => void,
  ) {
    this.externalId = `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    // The tool answers later — answering on the same tick would test an ordering that does not actually occur
    setTimeout(() => this.onSend(this, text), 5)
  }
  respondApproval(requestId: string, decision: string) {
    this.answered.push({ requestId, decision })
    return true
  }
  /** Like the Claude adapter: stopping cancels every app call this session made */
  interrupt() {
    this.interrupted = true
    this.opts.apps?.cancelAll()
  }
  async dispose() {
    this.disposed = true
  }
  say(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
  }
  done(output?: unknown) {
    this.emit(output === undefined ? { type: 'turn_complete', sessionId: this.sessionId } : { type: 'turn_complete', sessionId: this.sessionId, output })
  }
}

export class FakeAdapter implements AgentAdapter {
  descriptor: AgentAdapter['descriptor']
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  loggedIn = true
  /** How to answer what the agent receives — silence by default (the test decides) */
  onSend: (h: FakeHandle, text: string) => void = () => {}
  handles = new Map<string, FakeHandle>()
  opened: CreateSessionOpts[] = []
  constructor(readonly tool: ToolName, label: string) {
    this.descriptor = { name: tool, label, mark: label[0]!, install: 'x', login: `${tool} login` }
  }
  async detect() {
    return this.loggedIn
      ? { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
      : { tool: this.tool, installed: true, loggedIn: false, detail: `Not logged in — run \`${this.tool} login\`` }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.opened.push(opts)
    const h = new FakeHandle(opts.sessionId, opts, emit, (hh, t) => this.onSend(hh, t))
    this.handles.set(opts.sessionId, h)
    return h
  }
}

export type BrokerWorld = {
  root: string
  repo: string
  dataRoot: string
  store: Store
  rt: ExternalApps
  claude: FakeAdapter
  codex: FakeAdapter
  mgr: SessionManager
  rpc: ReturnType<typeof createRpcHandler>
  events: NormalizedEvent[]
  projectId: string
  /**
   * Answers the capability-question card (M4 D-4) in place of a person — allowed by default (for
   * a test that does not care about the question itself). null means nobody answers, and the test
   * inspects the card and answers it directly.
   */
  answerCapabilities: 'allow' | 'deny' | null
  /** Plants the fixture app (`--mode mediation`) — in the project (`repo`) or the user folder, with the manifest's `uses` */
  plant(where: 'project' | 'user', id: string, uses: Record<string, unknown>): string
  /** Calls the attached app's `ask_broker` as a session's agent would — the same path an agent calls an app tool through (A-5) */
  callFromSession(session: SessionInfo, server: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AppToolResult>
  /** The sessions the app stood up (excluding the calling session) */
  agentSessions(): SessionInfo[]
  dispose(): Promise<void>
}

/** The mediation's answer, returned by `ask_broker` (the fixture carries it in structuredContent) */
export const brokerSaid = (r: AppToolResult) => r.structuredContent as { isError: boolean; text: string; structured: unknown }

export async function brokerWorld(kit: PlantKit, timing: Partial<RuntimeTiming> = {}): Promise<BrokerWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-broker-')))
  const repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  const store = new Store()
  const claude = new FakeAdapter('claude', 'Claude Code')
  const codex = new FakeAdapter('codex', 'Codex')
  const adapters = new Map<ToolName, AgentAdapter>([
    ['claude', claude],
    ['codex', codex],
  ])
  const events: NormalizedEvent[] = []
  // eslint-disable-next-line prefer-const -- the world (w) is only assigned after the manager is created. The broadcast listener reads that later w
  let w: BrokerWorld
  const onEvent = (e: NormalizedEvent) => {
    events.push(e)
    // Answer in place of the person — **after** the card has stood up, as a real person would (answering on the same tick would test an ordering that does not actually occur)
    if (e.type === 'approval_request' && e.detail.kind === 'capability' && w?.answerCapabilities) {
      const answer = w.answerCapabilities
      setTimeout(() => {
        try {
          w.mgr.respondApproval(e.sessionId, e.requestId, answer)
        } catch {
          // the card was already closed in the meantime
        }
      }, 5)
    }
  }
  const mgr = new SessionManager(store, adapters, onEvent, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  const rt = new ExternalApps({
    projects: () => store.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    runs: storeRunLedger(store),
    permissions: storePermissionBook(store),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  mgr.useExternalApps(rt)
  const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  const projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
  w = {
    answerCapabilities: 'allow',
    root,
    repo,
    dataRoot,
    store,
    rt,
    claude,
    codex,
    mgr,
    rpc,
    events,
    projectId,
    plant(where, id, uses) {
      return kit.plantApp(where === 'project' ? join(repo, ...kit.PROJECT_APPS) : join(dataRoot, 'apps'), id, {
        server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'mediation'] },
        uses,
      })
    },
    callFromSession(session, server, args, signal) {
      const opts = (session.tool === 'codex' ? codex : claude).opened.find((o) => o.sessionId === session.id)!
      return opts.apps!.call(server, 'ask_broker', { mode: 'run', ...args }, signal ? { signal } : {})
    },
    agentSessions: () => mgr.listSessions().filter((s) => s.appId !== null),
    async dispose() {
      await mgr.disposeAll()
      await rt.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  return w
}
