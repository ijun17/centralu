import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from './adapters/contract.js'
import { runtimeViewSource } from './app-view-source.js'
import { ExternalApps } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { attachInlineViews, type InlineViews } from './inline-views.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'
import { FIXTURE_APP } from './sessions/session-apps.test-helpers.js'
import { OriginPorts } from './views/origin-ports.js'
import { ViewHost } from './views/view-host.js'

/**
 * 대화 안 앱 화면 (M4 B-1) — host 쪽 끝에서 끝까지.
 *
 * 진짜 매니저(기록·방송), 진짜 런타임과 앱 프로세스(픽스처 `inline` 모드), 진짜 ViewHost, 진짜 RPC 문.
 * 어댑터만 가짜다: 매니저가 넘긴 붙이기(`opts.apps`)를 들고 있다가, CLI의 대리 서버가 하듯 그것으로
 * 앱 도구를 부른다. 판정은 방송된 이벤트, 저장된 기록, 그리고 ViewHost가 그 인스턴스의 화면을 여는지다.
 */

class Handle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string) {}
  send() {}
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class CapturingAdapter implements AgentAdapter {
  tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  seen: CreateSessionOpts[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    this.seen.push(opts)
    return new Handle(opts.sessionId)
  }
}

const HOST_ORIGIN = 'http://127.0.0.1:5174'

let root = ''
let repo = ''
let logs = ''
let store: Store
let rt: ExternalApps
let views: ViewHost
let inline: InlineViews
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''
let events: NormalizedEvent[] = []
let logged: string[] = []

type AppView = Extract<NormalizedEvent, { type: 'app_view' }>
const appViews = () => events.filter((e): e is AppView => e.type === 'app_view')

function plant(id: string) {
  plantApp(join(repo, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'inline', '--log', join(logs, `${id}.jsonl`), '--gate', join(logs, `${id}.gate`)] },
  })
}

async function start(idleMs = 60_000) {
  const dataRoot = join(root, 'data')
  store = new Store()
  const adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e), () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({
    projects: () => store.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    watchFlushMs: 40,
    timing: { idleMs, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  // 짝을 못 찾은 호출을 오래 기다리지 않게 — 제품의 값은 5초다
  mgr.useExternalApps(rt, { callJoinWaitMs: 300 })
  views = new ViewHost({
    secret: 'inline-views-test-secret-0123456789abcdef',
    allowedOrigins: [HOST_ORIGIN],
    source: runtimeViewSource(rt),
    ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
    // 주소를 지을 포트만 있으면 된다 — 이 시험은 주소를 열지 않고, 인스턴스가 열려 있는지와 문서를 본다
    hostPort: () => 1,
    log: () => {},
  })
  inline = attachInlineViews(mgr, rt, views, (line) => logged.push(line))
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt, views, inlineViews: inline })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
  const session = (await rpc('agents.createSession', { projectId, cwd: repo, tool: 'claude' })) as SessionInfo
  const apps = adapter.seen.at(-1)!.apps!
  // CLI가 세션을 시작하며 하는 일 — 붙은 앱의 목록을 읽는다(앱이 여기서 뜬다)
  await apps.tools('app-viewer')
  return { sessionId: session.id, apps }
}

const frame = (instanceId: string, appId = 'viewer') => views.frame({ app: { appId, projectId }, instanceId, hostOrigin: HOST_ORIGIN })
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const viewerPid = () => {
  const lines = readFileSync(join(logs, 'viewer.jsonl'), 'utf8').trim().split('\n')
  return (JSON.parse(lines.findLast((l) => l.includes('"t":"start"'))!) as { pid: number }).pid
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-inline-views-')))
  repo = join(root, 'repo')
  logs = join(root, 'logs')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  for (const d of [dataRoot, logs]) mkdirSync(d)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  plant('viewer')
  plant('other')
  events = []
  logged = []
})

afterEach(async () => {
  inline?.dispose()
  await mgr?.disposeAll()
  await views?.dispose()
  await rt?.dispose()
  store?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('화면이 달린 도구를 부르면 카드 아래에 화면이 선다', () => {
  it('인스턴스를 열고, 그 카드 id로 시작(입력)과 끝(결과)을 알린다 — 기록에는 본문 없이 열림만 남는다', async () => {
    const { sessionId, apps } = await start()
    const out = await apps.call('app-viewer', 'show', { q: 'weather' }, { callId: 'toolu_A' })
    // 에이전트가 받는 결과는 그대로다 — 화면은 덧붙임이다
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'shown weather' }], isError: false })

    await until(appViews, (v) => v.some((e) => e.phase === 'result'))
    const [open, result] = appViews()
    expect(open).toMatchObject({
      type: 'app_view', sessionId, callId: 'toolu_A', appId: 'viewer', projectId, tool: 'show', phase: 'open', toolInput: { q: 'weather' },
    })
    expect(open!.instanceId).toEqual(expect.any(String))
    expect(open!.seq).toEqual(expect.any(Number))
    expect(result).toMatchObject({
      callId: 'toolu_A', phase: 'result',
      toolResult: { content: [{ type: 'text', text: 'shown weather' }], structuredContent: { q: 'weather', by: 'viewer' } },
    })
    expect(appViews()).toHaveLength(2)

    // 열린 인스턴스다 — 그 앱이 내놓은 문서가 화면이 된다
    await expect(frame(open!.instanceId!)).resolves.toMatchObject({ url: expect.stringContaining(`/views/${open!.instanceId}/`) })
    // 기록: 이 카드 아래에 viewer의 화면이 섰다는 사실만. 입력도 인스턴스도 싣지 않는다
    const rows = store.loadMessages(sessionId).filter((m) => m.kind === 'app_view')
    expect(rows.map((r) => r.payload)).toEqual([
      { type: 'app_view', sessionId, callId: 'toolu_A', appId: 'viewer', projectId, tool: 'show', phase: 'open' },
    ])
  })

  it('화면이 없는 에이전트 도구는 아무것도 열지 않는다', async () => {
    const { apps } = await start()
    const open = vi.spyOn(views, 'open')
    await apps.call('app-viewer', 'plain', {}, { callId: 'toolu_B' })
    // 화면이 달린 호출 하나를 뒤에 세워, 앞의 호출이 무엇을 냈다면 이미 도착했을 때까지 기다린다
    await apps.call('app-viewer', 'show', { q: 'after' }, { callId: 'toolu_C' })
    await until(appViews, (v) => v.some((e) => e.callId === 'toolu_C' && e.phase === 'result'))
    expect(appViews().filter((e) => e.callId === 'toolu_B')).toEqual([])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('남의 화면을 선언한 도구는 화면을 열지 않고 거절을 남긴다 — 호출은 그대로 돈다', async () => {
    const { sessionId, apps } = await start()
    // other는 ui://other/main을 정말로 내놓는 앱이다 — 사칭 대상이 실재한다
    expect((await rt.listResources({ projectId, appId: 'other' })).map((r) => r.uri)).toEqual(['ui://other/main'])
    const open = vi.spyOn(views, 'open')
    const out = await apps.call('app-viewer', 'spoof', {}, { callId: 'toolu_S' })
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'spoofed' }] })

    await until(appViews, (v) => v.length > 0)
    expect(open).not.toHaveBeenCalled()
    expect(appViews()).toEqual([
      expect.objectContaining({ callId: 'toolu_S', appId: 'viewer', phase: 'rejected', reason: expect.stringContaining('This app does not serve ui://other/main') }),
    ])
    // 거절이 기록된다 — 대화의 그 자리에, 그리고 host 로그에
    const rows = store.loadMessages(sessionId).filter((m) => m.kind === 'app_view')
    expect(rows.map((r) => (r.payload as AppView).phase)).toEqual(['rejected'])
    expect(logged.some((l) => l.includes('viewer spoof: view rejected'))).toBe(true)
  })

  it('결과가 남의 화면을 가리키면 연 화면을 닫고 거절한다', async () => {
    const { apps } = await start()
    await apps.call('app-viewer', 'spoof_result', {}, { callId: 'toolu_R' })
    await until(appViews, (v) => v.some((e) => e.phase === 'rejected'))
    const [open, rejected] = appViews()
    expect(open).toMatchObject({ phase: 'open', callId: 'toolu_R' })
    expect(rejected).toMatchObject({ phase: 'rejected', callId: 'toolu_R', reason: expect.stringContaining('ui://other/main') })
    await expect(frame(open!.instanceId!)).rejects.toThrow(/not open/)
  })

  it('취소된 호출은 취소로 끝난다 — 화면은 tool-cancelled를 받는다', async () => {
    const { apps } = await start()
    const stop = new AbortController()
    const p = apps.call('app-viewer', 'hold_view', {}, { callId: 'toolu_H', signal: stop.signal })
    await until(appViews, (v) => v.some((e) => e.phase === 'open'))
    stop.abort()
    expect((await p).isError).toBe(true)
    await until(appViews, (v) => v.some((e) => e.phase !== 'open'))
    expect(appViews().map((e) => [e.callId, e.phase])).toEqual([
      ['toolu_H', 'open'],
      ['toolu_H', 'cancelled'],
    ])
    expect(appViews()[1]!.reason).toMatch(/취소/)
  })
})

describe('화면을 닫는 길', () => {
  it('UI가 닫으면 인스턴스를 닫는다 (apps.closeView)', async () => {
    const { apps } = await start()
    await apps.call('app-viewer', 'show', { q: 'x' }, { callId: 'toolu_U' })
    await until(appViews, (v) => v.some((e) => e.phase === 'result'))
    const id = appViews()[0]!.instanceId!
    await expect(rpc('apps.closeView', { instanceId: id })).resolves.toEqual({ ok: true })
    await expect(frame(id)).rejects.toThrow(/not open/)
    expect(inline.owner(id)).toBeNull()
  })

  it('세션을 지우면 그 세션의 화면이 닫히고, 붙들던 앱을 놓아 쉬는 앱으로 내려간다', async () => {
    const { sessionId, apps } = await start(300)
    await apps.call('app-viewer', 'show', { q: 'x' }, { callId: 'toolu_D' })
    await until(appViews, (v) => v.some((e) => e.phase === 'result'))
    const id = appViews()[0]!.instanceId!
    const pid = viewerPid()
    // 화면이 붙들고 있다 — 쉬는 시간이 지나도 내려가지 않는다
    await new Promise((r) => setTimeout(r, 900))
    expect(alive(pid)).toBe(true)

    await rpc('agents.deleteSession', { sessionId })
    await expect(frame(id)).rejects.toThrow(/not open/)
    await until(() => alive(pid), (a) => a === false, 4000)
  })

  it('앱이 사라지면 화면을 닫고 이유를 알린다', async () => {
    const { apps } = await start()
    await apps.call('app-viewer', 'show', { q: 'x' }, { callId: 'toolu_G' })
    await until(appViews, (v) => v.some((e) => e.phase === 'result'))
    const id = appViews()[0]!.instanceId!
    rmSync(join(repo, ...PROJECT_APPS, 'viewer'), { recursive: true, force: true })
    rt.refresh()
    await until(appViews, (v) => v.some((e) => e.phase === 'closed'))
    expect(appViews().at(-1)).toMatchObject({ callId: 'toolu_G', phase: 'closed', reason: 'This app was removed' })
    await expect(frame(id)).rejects.toThrow(/not open/)
  })

  it('신뢰를 잃은 프로젝트의 화면도 닫는다 — 화면의 HTML도 그 프로젝트의 코드다', async () => {
    const { apps } = await start()
    await apps.call('app-viewer', 'show', { q: 'x' }, { callId: 'toolu_T' })
    await until(appViews, (v) => v.some((e) => e.phase === 'result'))
    const id = appViews()[0]!.instanceId!
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await until(appViews, (v) => v.some((e) => e.phase === 'closed'))
    expect(appViews().at(-1)).toMatchObject({ callId: 'toolu_T', phase: 'closed', reason: "This app's project is no longer trusted" })
    await expect(frame(id)).rejects.toThrow(/not open/)
  })
})

describe('카드를 못 찾은 호출', () => {
  it('어댑터가 id를 주지 않고 짝도 없으면 화면을 열지 않는다 — 호출은 그대로 돈다', async () => {
    const { apps } = await start()
    const open = vi.spyOn(views, 'open')
    const out = await apps.call('app-viewer', 'show', { q: 'lost' })
    expect(out.isError).toBe(false)
    await until(() => logged, (l) => l.some((x) => x.includes('no conversation card matched')))
    expect(open).not.toHaveBeenCalled()
    expect(appViews()).toEqual([])
  })
})
