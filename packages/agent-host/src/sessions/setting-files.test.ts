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
 * The setting files a tool receives per session (M4 decision 3, #92/#152) — kind × project trust ×
 * preset, both when created and when woken up.
 *
 *   orchestrator, coordinating session          no files at all (Claude's `settingSources: []`, Codex
 *                                                turns off its store layer)
 *   worker, manager, a project app's building    exactly that project's trust
 *   session, an agent a project app assigned (D-1)
 *   a user-folder app's building session         trusted — that folder is the user's own
 *   an agent a user-folder app assigned (D-1)    only the person's own settings — the text was
 *                                                written by the app, and the folder
 *                                                (orchestratorHome) can be written by a worker
 *
 * A real manager spins up a real adapter. Only the tool is mocked: for Claude, the SDK's `query`
 * records what it received, and for Codex, the app-server client does — what this test checks is
 * "what did the tool receive." What the CLI reads from that value is measured separately by
 * adapters/claude/project-trust.test.ts (the SDK's merge engine) and
 * scripts/probe-project-trust.mts (the real CLI).
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
          // An event must arrive before the manager records the conversation id — otherwise the next wake would not be a real resume
          await new Promise((r) => setTimeout(r, 0))
          yield { type: 'system', subtype: 'status', status: null }
          await new Promise(() => {}) // the session stays alive
        },
        interrupt: async () => {},
        close: () => {},
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
 * The conversation list and history read the tool's own store (~/.claude's conversation files,
 * the codex app-server) — what this test checks is only the options at spawn time. Without them,
 * the manager treats it as "unknown" and does not block waking up (externalIndexOf).
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

/** Decision 3's table — the entire contract this file holds */
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

/** Stands up a session of that kind through the same path the product uses — right up through the tool's first launch */
const MAKE: Record<Kind, (tool: ToolName) => Promise<string>> = {
  orchestrator: async (tool) => {
    mgr.configureOrchestrator(tool)
    return (await mgr.orchestrator()).id
  },
  coordinator: async (tool) => {
    const member = (await rpc('agents.createSession', { projectId, cwd: repo, tool })) as SessionInfo
    return (await mgr.createCoordinator({ name: 'Crew', memberSessionIds: [member.id], roleAppend: 'Coordinating session', tool })).id
  },
  worker: async (tool) => ((await rpc('agents.createSession', { projectId, cwd: repo, tool })) as SessionInfo).id,
  manager: async (tool) => {
    store.setProjectDefaultTool(projectId, tool)
    const seat = (await rpc('worktrees.createManager', { projectId, baseBranch: 'main' })) as SessionInfo
    // The manager's seat stands up first, on its own — it receives a tool and files only the first time it is woken
    await mgr.resumeSession(seat.id)
    return seat.id
  },
  'project-app builder': async (tool) => {
    // An app and its building session only stand up in a trusted project
    await rpc('projects.setTrusted', { projectId, trusted: true })
    return ((await rpc('apps.create', { projectId, id: 'notes', name: 'Notes', tool })) as Created).builder!.id
  },
  'user-folder-app builder': async (tool) =>
    ((await rpc('apps.create', { projectId: null, id: 'timer', name: 'Timer', tool })) as Created).builder!.id,
  'project-app agent': (tool) => appAgent(tool, projectId, 'notes'),
  'user-folder-app agent': (tool) => appAgent(tool, null, 'timer'),
}

/**
 * An agent an app assigned (M4 D-1) — stood up through the same door the intermediary calls
 * (`runAppAgent`). The id is received the moment the session stands up, and the turn is never
 * finished (the fake tool never answers) — what is checked here is only what it received at
 * launch. The adapter is made to report that it is installed and logged in: Codex is not logged
 * in on this machine, and being logged in is not what this test checks.
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
/** Codex does not turn off the user's ~/.codex per thread — only the store layer can be turned off, so none and user share the same value */
const CODEX_FILES: Record<Files, string> = { none: 'repo-off', user: 'repo-off', all: 'all' }

const settle = () => new Promise((r) => setTimeout(r, 5))
const trustedNow = () => store.projectRoots().find((p) => p.id === projectId)!.trusted

/** One line summarizing what the tool that just launched received — which path (new or resumed), which setting files, which permission */
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
  // A resume (thread/resume) does not carry permissions — what is checked here is the files
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

describe.each(['claude', 'codex'] as const)('%s — the session\'s kind decides the setting files (not whether the tool receives them)', (tool) => {
  it.each(Object.keys(FILES) as Kind[])('%s: at creation, and again on every wake across trust × preset', async (kind) => {
    const id = await MAKE[kind](tool)
    await settle()
    // An agent an app calls stands up as safe — the person's global bypass does not carry over to an app's instruction (runAppAgent)
    const born: PermissionPreset = kind === 'project-app agent' || kind === 'user-folder-app agent' ? 'safe' : 'normal'
    const seen = [launched(tool, id, born)]
    // The manager stands up its seat first and only launches on its first wake — everything else launches at creation
    const want = [expected(tool, kind, trustedNow(), born, 'new')]
    for (const trusted of [false, true]) {
      await rpc('projects.setTrusted', { projectId, trusted })
      for (const preset of PRESETS) {
        await mgr.updateSettings(id, { permissionPreset: preset })
        // Trust only takes effect the next time it launches — relaunch through the wake path (resumeSession)
        expect((await mgr.restartSession(id)).resumed).toBe(true)
        await settle()
        seen.push(launched(tool, id, preset))
        want.push(expected(tool, kind, trusted, preset, 'resume'))
      }
    }
    expect(seen).toEqual(want)
  })
})
