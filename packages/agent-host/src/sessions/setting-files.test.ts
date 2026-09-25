import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, PermissionPreset, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { ClaudeAdapter } from '../adapters/claude/index.js'
import { CodexAdapter } from '../adapters/codex/index.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * 세션마다 도구가 받는 설정 파일 (M4 결정 3, #92·#152) — 종류 × 프로젝트 신뢰 × 프리셋, 만들 때와 깨울 때.
 *
 *   오케스트레이터·조율 세션                  아무 파일도 (Claude `settingSources: []`, Codex는 저장소 층을 끈다)
 *   워커·매니저·프로젝트 앱의 만드는 세션,    그 프로젝트의 신뢰 그대로
 *   프로젝트 앱이 부탁한 에이전트(D-1)
 *   사용자 폴더 앱의 만드는 세션              신뢰 — 그 폴더는 사용자 자신의 것이다
 *   사용자 폴더 앱이 부탁한 에이전트(D-1)     사람 자신의 설정만 — 글은 앱이 썼고, 폴더(orchestratorHome)는 워커가 쓸 수 있다
 *
 * 진짜 매니저가 진짜 어댑터를 띄운다. 도구만 흉내다: Claude는 SDK의 `query`가, Codex는 app-server 클라이언트가
 * 받은 것을 적는다 — 이 테스트가 보는 것은 "도구가 무엇을 받았나"다. 그 값으로 CLI가 무엇을 읽는지는
 * adapters/claude/project-trust.test.ts(SDK의 병합 엔진)와 scripts/probe-project-trust.mts(실제 CLI)가 잰다.
 */

const state = vi.hoisted(() => ({
  claude: [] as Record<string, unknown>[],
  codex: [] as { method: string; params: Record<string, unknown> }[],
  n: 0,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    query: ({ options }: { options: Record<string, unknown> }) => {
      state.claude.push(options)
      const conversation = `claude-${++state.n}`
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: conversation }
          // 이벤트가 하나 와야 매니저가 대화 id를 적는다 — 그래야 다음 깨우기가 진짜 재개(resume)다
          await new Promise((r) => setTimeout(r, 0))
          yield { type: 'system', subtype: 'status', status: null }
          await new Promise(() => {}) // 세션은 살아 있다
        },
        interrupt: async () => {},
        supportedCommands: async () => [],
        getContextUsage: async () => undefined,
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      }
    },
  }
})

vi.mock('../adapters/codex/client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.codex.push({ method, params: params ?? {} })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `codex-${++state.n}` } })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params?.threadId } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

/**
 * 대화 목록·기록은 도구의 저장소(~/.claude의 대화 파일, codex app-server)를 읽는다 — 이 테스트가 보는 것은 띄울 때의
 * 옵션뿐이다. 없으면 매니저는 "모른다"로 보고 깨우기를 막지 않는다(externalIndexOf).
 */
function offline(a: AgentAdapter): AgentAdapter {
  a.listExternalSessions = undefined
  a.readExternalHistory = undefined
  return a
}

let root = ''
let repo = ''
let adapters: Map<ToolName, AgentAdapter>
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

beforeEach(async () => {
  state.claude.length = 0
  state.codex.length = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-setting-files-')))
  repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  adapters = new Map<ToolName, AgentAdapter>([
    ['claude', offline(new ClaudeAdapter())],
    ['codex', offline(new CodexAdapter())],
  ])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'], builderBusy: (ref) => mgr.builderBusy(ref) })
  rt.refresh()
  mgr.useExternalApps(rt)
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

type Kind =
  | 'orchestrator'
  | 'coordinator'
  | 'worker'
  | 'manager'
  | 'project-app builder'
  | 'user-folder-app builder'
  | 'project-app agent'
  | 'user-folder-app agent'
type Files = 'none' | 'user' | 'all'
type Created = { app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }

/** 결정 3의 표 — 이 파일이 지키는 약속 전부다 */
const FILES: Record<Kind, (projectTrusted: boolean) => Files> = {
  orchestrator: () => 'none',
  coordinator: () => 'none',
  worker: (t) => (t ? 'all' : 'user'),
  manager: (t) => (t ? 'all' : 'user'),
  'project-app builder': (t) => (t ? 'all' : 'user'),
  'user-folder-app builder': () => 'all',
  'project-app agent': (t) => (t ? 'all' : 'user'),
  'user-folder-app agent': () => 'user',
}

/** 그 종류의 세션을 제품이 세우는 길로 세운다 — 도구가 처음 뜨는 것까지 */
const MAKE: Record<Kind, (tool: ToolName) => Promise<string>> = {
  orchestrator: async (tool) => {
    mgr.configureOrchestrator(tool)
    return (await mgr.orchestrator()).id
  },
  coordinator: async (tool) => {
    const member = (await rpc('agents.createSession', { projectId, cwd: repo, tool })) as SessionInfo
    return (await mgr.createCoordinator({ name: 'Crew', memberSessionIds: [member.id], roleAppend: '조율 세션', tool })).id
  },
  worker: async (tool) => ((await rpc('agents.createSession', { projectId, cwd: repo, tool })) as SessionInfo).id,
  manager: async (tool) => {
    store.setProjectDefaultTool(projectId, tool)
    const seat = (await rpc('worktrees.createManager', { projectId, baseBranch: 'main' })) as SessionInfo
    // 매니저는 자리만 먼저 선다 — 도구와 파일은 처음 깰 때 받는다
    await mgr.resumeSession(seat.id)
    return seat.id
  },
  'project-app builder': async (tool) => {
    // 신뢰한 프로젝트에만 앱과 만드는 세션이 선다
    await rpc('projects.setTrusted', { projectId, trusted: true })
    return ((await rpc('apps.create', { projectId, id: 'notes', name: 'Notes', tool })) as Created).builder!.id
  },
  'user-folder-app builder': async (tool) =>
    ((await rpc('apps.create', { projectId: null, id: 'timer', name: 'Timer', tool })) as Created).builder!.id,
  'project-app agent': (tool) => appAgent(tool, projectId, 'notes'),
  'user-folder-app agent': (tool) => appAgent(tool, null, 'timer'),
}

/**
 * 앱이 부탁한 에이전트 (M4 D-1) — 중개 창구가 부르는 그 문(`runAppAgent`)으로 세운다. 세션이 서는 순간 id를 받고, 턴은
 * 끝나지 않는다(가짜 도구는 답하지 않는다) — 여기서 보는 것은 띄울 때 받은 것이다. 도구가 깔렸고 로그인했다고 답하게
 * 한다: 이 기계의 Codex는 로그인하지 않았고, 이 시험이 보는 것은 로그인이 아니다.
 */
async function appAgent(tool: ToolName, appProjectId: string | null, appId: string): Promise<string> {
  const adapter = adapters.get(tool)!
  adapter.detect = async () => ({ tool, installed: true, loggedIn: true, detail: 'test' })
  return new Promise<string>((resolve, reject) => {
    mgr
      .runAppAgent(
        { app: { projectId: appProjectId, appId }, appName: `App ${appId}`, tool, prompt: 'look around' },
        { signal: new AbortController().signal, progress: () => {}, onSession: resolve },
      )
      .catch(reject)
  })
}

const PRESETS: PermissionPreset[] = ['safe', 'normal', 'auto']
const CLAUDE_PERMISSION: Record<PermissionPreset, string> = { safe: 'default', normal: 'from-settings', auto: 'bypassPermissions' }
const CODEX_PERMISSION: Record<PermissionPreset, string> = { safe: 'untrusted/workspace-write', normal: 'from-settings', auto: 'never/workspace-write' }
/** Codex는 사용자의 ~/.codex를 스레드 단위로 끄지 않는다 — 끌 수 있는 것은 저장소 층뿐이라 none과 user가 같은 값이다 */
const CODEX_FILES: Record<Files, string> = { none: 'repo-off', user: 'repo-off', all: 'all' }

const settle = () => new Promise((r) => setTimeout(r, 5))
const trustedNow = () => store.projectRoots().find((p) => p.id === projectId)!.trusted

/** 방금 뜬 도구가 받은 것 한 줄 — 어느 길로(새로·재개), 어떤 설정 파일, 어떤 권한 */
function launched(tool: ToolName, sessionId: string, preset: PermissionPreset): string {
  const head = `trust=${trustedNow() ? 'yes' : 'no'} preset=${preset}`
  if (tool === 'claude') {
    const o = state.claude.at(-1)!
    const sources = JSON.stringify(o.settingSources)
    const files = !('settingSources' in o) ? 'all' : sources === '[]' ? 'none' : sources === '["user"]' ? 'user' : sources
    const permission = o.resolvePermissionModeInCli ? 'from-settings' : String(o.permissionMode)
    return `${head}: ${o.resume ? 'resume' : 'new'} files=${files} permission=${permission}`
  }
  const { method, params } = state.codex.filter((r) => r.method === 'thread/start' || r.method === 'thread/resume').at(-1)!
  const config = params.config as { project_doc_max_bytes?: number; projects?: Record<string, { trust_level?: string }> }
  const doc = config.project_doc_max_bytes
  const cwdTrust = config.projects?.[store.sessionCwd(sessionId)!]?.trust_level
  const files =
    doc === 0 && cwdTrust === 'untrusted' ? 'repo-off'
    : doc === undefined && config.projects === undefined ? 'all'
    : `doc=${doc ?? 'unset'} cwd-trust=${cwdTrust ?? 'unset'}`
  // 재개(thread/resume)에는 권한을 싣지 않는다 — 여기서 보는 것은 파일이다
  const permission =
    method === 'thread/resume' ? '' : ` permission=${params.approvalPolicy ? `${String(params.approvalPolicy)}/${String(params.sandbox)}` : 'from-settings'}`
  return `${head}: ${method === 'thread/resume' ? 'resume' : 'new'} files=${files}${permission}`
}

function expected(tool: ToolName, kind: Kind, t: boolean, preset: PermissionPreset, via: 'new' | 'resume'): string {
  const head = `trust=${t ? 'yes' : 'no'} preset=${preset}: ${via}`
  const files = FILES[kind](t)
  if (tool === 'claude') return `${head} files=${files} permission=${CLAUDE_PERMISSION[preset]}`
  return `${head} files=${CODEX_FILES[files]}${via === 'resume' ? '' : ` permission=${CODEX_PERMISSION[preset]}`}`
}

describe.each(['claude', 'codex'] as const)('%s — 세션의 종류가 설정 파일을 정한다 (도구를 받는지가 아니라)', (tool) => {
  it.each(Object.keys(FILES) as Kind[])('%s: 만들 때와, 신뢰 × 프리셋마다 다시 깨울 때', async (kind) => {
    const id = await MAKE[kind](tool)
    await settle()
    // 앱이 부른 에이전트는 safe로 선다 — 사람의 전역 bypass도 앱의 지시에는 건너가지 않는다(runAppAgent)
    const born: PermissionPreset = kind === 'project-app agent' || kind === 'user-folder-app agent' ? 'safe' : 'normal'
    const seen = [launched(tool, id, born)]
    // 매니저는 자리가 먼저 서고 처음 깨울 때 새로 뜬다 — 나머지는 만들 때 새로 뜬다
    const want = [expected(tool, kind, trustedNow(), born, 'new')]
    for (const trusted of [false, true]) {
      await rpc('projects.setTrusted', { projectId, trusted })
      for (const preset of PRESETS) {
        await mgr.updateSettings(id, { permissionPreset: preset })
        // 신뢰는 다음에 뜰 때 닿는다 — 깨우는 길(resumeSession)로 다시 띄운다
        expect((await mgr.restartSession(id)).resumed).toBe(true)
        await settle()
        seen.push(launched(tool, id, preset))
        want.push(expected(tool, kind, trusted, preset, 'resume'))
      }
    }
    expect(seen).toEqual(want)
  })
})
