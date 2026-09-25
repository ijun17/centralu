import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, AppToolResult, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps, type RuntimeTiming } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP, type PlantKit } from './session-apps.test-helpers.js'

/**
 * 앱의 중개(M4 D)를 매니저까지 이어서 보는 시험의 세계 — 진짜 매니저·런타임·앱 프로세스(픽스처의 `mediation`)·실행 기록.
 * 어댑터만 가짜다: 받은 옵션을 적고, 시험이 정한 대로 에이전트의 답을 흘린다.
 *
 * (테스트 전용 파일이다. 앱 폴더를 심는 손은 `session-apps.test-helpers.ts`처럼 시험 파일이 넘긴다)
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
    // 도구는 나중에 답한다 — 같은 틱에 답하면 실제로는 없는 순서를 시험하게 된다
    setTimeout(() => this.onSend(this, text), 5)
  }
  respondApproval(requestId: string, decision: string) {
    this.answered.push({ requestId, decision })
    return true
  }
  /** Claude 어댑터처럼: 멈추면 이 세션이 부른 앱 호출을 모두 취소한다 */
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
  /** 에이전트가 받은 말에 어떻게 답하나 — 기본은 아무 말도 없다(시험이 정한다) */
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
  /** 픽스처 앱(`--mode mediation`)을 심는다 — 프로젝트(`repo`) 또는 사용자 폴더에, 매니페스트의 `uses`와 함께 */
  plant(where: 'project' | 'user', id: string, uses: Record<string, unknown>): string
  /** 세션의 에이전트가 붙은 앱의 `ask_broker`를 부른다 — 에이전트가 앱 도구를 부르는 그 길(A-5) */
  callFromSession(session: SessionInfo, server: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AppToolResult>
  /** 앱이 세운 세션들 (부른 세션은 빼고) */
  agentSessions(): SessionInfo[]
  dispose(): Promise<void>
}

/** `ask_broker`가 돌려준 중개의 답 (픽스처가 structuredContent에 싣는다) */
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
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  const rt = new ExternalApps({
    projects: () => store.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  mgr.useExternalApps(rt)
  const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  const projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
  const w: BrokerWorld = {
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
