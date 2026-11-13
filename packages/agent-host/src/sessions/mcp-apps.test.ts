import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts } from '../adapters/contract.js'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { CapturingAdapter, FIXTURE_APP } from './session-apps.test-helpers.js'
import { DEFAULT_RARE_TIER, setRareTier } from './centralu-tools.js'

/**
 * An MCP server a person approved becomes a headless app in the user folder (M4 A-7, decision 8).
 *
 * It used to be that, once approved, a server was written to app_settings
 * (`orchestrator_mcp_servers`) and loaded raw into the Assistant's MCP configuration — a call
 * passed through neither an intermediary nor a record, and there was no listing and no removal.
 * This is checked here with a real store, a real runtime and a real app process (a fixture); only
 * the adapter is fake — it records the options it received, and an attached app is called through
 * the session's live attachment (`liveFor`) — the same door Centralu's `app` tool calls through
 * (#2231).
 */

const LEGACY_KEY = 'orchestrator_mcp_servers'
const SERVER = { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] }

let root = ''
let dataRoot = ''
let repo = ''
let store: Store
let rt: ExternalApps
let adapter: CapturingAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

/** Connects the manager to the runtime — this is also the moment the legacy registry is migrated (the same seam as the host's main) */
function connect(): void {
  mgr.apps.useExternalApps(rt)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-apps-')))
  dataRoot = join(root, 'data')
  repo = join(root, 'repo')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  mkdirSync(dataRoot)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({
    projects: () => store.projects.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
})

afterEach(async () => {
  await mgr.tenure.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

const manifestPath = (id: string) => join(dataRoot, 'apps', id, 'centralu.app.json')
const readManifest = (id: string) => JSON.parse(readFileSync(manifestPath(id), 'utf8')) as Record<string, unknown>
const userApps = () => rt.list().filter((a) => a.projectId === null).map((a) => a.appId)
const attached = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server) ?? []
/** The session's live attachment, as Centralu's `app` tool reaches it (#2231) */
const live = (sessionId: string) => mgr.apps.sessionAppsHub()!.liveFor(sessionId)!

async function proposeAndApprove(name: string, server = SERVER, why?: string) {
  const orc = await mgr.assistant()
  const r = await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name, ...server, ...(why ? { why } : {}) })
  expect(r.isError).toBeFalsy()
  return { orc, resolved: await mgr.assistantSlot.resolveMcpProposal(name, true) }
}

/*
 * These call the Assistant's rare commands by their own names, as tools: the `resident` tier (#512). The
 * default tier serves them through centralu_run, to the same runners; command-tier.test.ts covers that door.
 */
beforeAll(() => setRareTier('resident'))
afterAll(() => setRareTier(DEFAULT_RARE_TIER))

describe('an approved MCP server becomes a user-folder app (A-7)', () => {
  it('a proposal creates nothing; approval creates the app, which the Assistant reaches with no restart, and the tool is recorded going through the intermediary', async () => {
    connect()
    const orc = await mgr.assistant()
    await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'echoer', ...SERVER, why: 'test server' })
    expect(mgr.assistantSlot.mcpProposals().map((p) => p.name)).toEqual(['echoer'])
    // Nothing exists yet at the proposal stage
    expect(existsSync(join(dataRoot, 'apps', 'echoer'))).toBe(false)
    expect(userApps()).toEqual([])

    const before = adapter.seen.length
    expect(await mgr.assistantSlot.resolveMcpProposal('echoer', true)).toEqual({ ok: true })
    expect(mgr.assistantSlot.mcpProposals()).toEqual([])

    // A headless app: only a server command, no home. The app stands without starting (it starts the first time it is needed)
    const m = readManifest('echoer')
    expect(m).toMatchObject({ manifestVersion: 1, id: 'echoer', name: 'echoer', description: 'test server', server: SERVER })
    expect(m).not.toHaveProperty('home')
    expect(rt.list().find((a) => a.appId === 'echoer')).toMatchObject({ projectId: null, status: 'stopped', trusted: true, error: null })
    // It is not written to the legacy registry
    expect(store.settings.appSetting(LEGACY_KEY)).toBeNull()

    // Nothing restarted (#2231): that server is the Assistant's app at once, reached through the `app` tool — no server is loaded raw
    expect(adapter.seen.length).toBe(before)
    const o = adapter.last()
    expect(o.sessionId).toBe(orc.id)
    expect(attached(o)).toEqual(['app-echoer'])
    expect(o).not.toHaveProperty('extraMcpServers')

    // Calling that tool goes through the intermediary and is recorded with the caller (this Assistant). It writes, and the
    // Assistant's preset asks about a write: the host's card, which the person allows
    const call = live(orc.id).call('app-echoer', 'poke', { to: 3 })
    const card = await until(() => mgr.sessionInfo(orc.id)?.pendingApproval, (p) => p !== undefined && p !== null)
    expect(card!.detail).toMatchObject({ kind: 'other', raw: 'echoer: poke {"to":3}', about: 'app_call' })
    // The card offers no "always": one sent anyway is read as allow, once, and nothing is remembered for the next call
    mgr.inputs.respondApproval(orc.id, card!.requestId, 'always')
    const out = await call
    expect(out.isError).toBeFalsy()
    expect(out.content).toEqual([{ type: 'text', text: 'poked 3' }])
    const again = live(orc.id).call('app-echoer', 'poke', { to: 4 })
    const second = await until(() => mgr.sessionInfo(orc.id)?.pendingApproval, (p) => p !== undefined && p !== null && p.requestId !== card!.requestId)
    expect(second!.detail).toMatchObject({ kind: 'other', raw: 'echoer: poke {"to":4}', about: 'app_call' })
    mgr.inputs.respondApproval(orc.id, second!.requestId, 'deny')
    await again
    expect(rt.runs({ projectId: null, appId: 'echoer' })).toEqual([
      expect.objectContaining({ tool: 'poke', status: 'ok', callerKind: 'session', callerSessionId: orc.id }),
    ])
  })

  it('a rejection only clears the proposal — no app, no restart', async () => {
    connect()
    const orc = await mgr.assistant()
    await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'figma', command: 'npx', args: [] })
    const before = adapter.seen.length
    await mgr.assistantSlot.resolveMcpProposal('figma', false)
    expect(mgr.assistantSlot.mcpProposals()).toEqual([])
    expect(userApps()).toEqual([])
    expect(adapter.seen.length).toBe(before)
  })

  it('cannot be proposed under the name of an existing app or a reserved id — overwriting would be swapping out the command', async () => {
    connect()
    const { orc } = await proposeAndApprove('dup')
    const again = await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'dup', command: 'evil', args: [] })
    expect(again.isError).toBe(true)
    expect(readManifest('dup').server).toEqual(SERVER)

    const builtin = await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'control', command: 'npx', args: [] })
    expect(builtin.isError).toBe(true)
    expect(mgr.assistantSlot.mcpProposals()).toEqual([])
  })

  it('if a different app with the same id appeared while it was awaiting approval, it fails instead of overwriting, and the proposal stays', async () => {
    connect()
    const orc = await mgr.assistant()
    await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'taken', command: 'npx', args: ['-y', 'x'] })
    plantApp(join(dataRoot, 'apps'), 'taken', { server: SERVER })
    const r = await mgr.assistantSlot.resolveMcpProposal('taken', true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('taken')
    expect(readManifest('taken').server).toEqual(SERVER)
    expect(mgr.assistantSlot.mcpProposals().map((p) => p.name)).toEqual(['taken'])
  })
})

describe('migrates an approved server from the legacy registry (A-7)', () => {
  it('migrates once at startup, and running again yields the same result — only migrated entries are cleared from the legacy key, entries that could not be migrated stay', async () => {
    const legacy = [
      { name: 'echoer', ...SERVER },
      // A name approved before #93 — it cannot be a valid app id
      { name: 'centralu', command: 'npx', args: ['-y', 'whatever'] },
    ]
    store.settings.setAppSetting(LEGACY_KEY, JSON.stringify(legacy))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(readManifest('echoer')).toMatchObject({ id: 'echoer', server: SERVER })
    expect(JSON.parse(store.settings.appSetting(LEGACY_KEY)!)).toEqual([{ name: 'centralu', command: 'npx', args: ['-y', 'whatever'] }])

    /*
     * Suppose the host died after writing the app but before clearing the key — the legacy key is
     * left just as it was at the start. The next startup tries to migrate the same entry again,
     * and it must not end up with two apps or overwrite the app already migrated.
     */
    store.settings.setAppSetting(LEGACY_KEY, JSON.stringify(legacy))
    const written = statSync(manifestPath('echoer')).mtimeMs
    const text = readFileSync(manifestPath('echoer'), 'utf8')
    await new Promise((r) => setTimeout(r, 30))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(statSync(manifestPath('echoer')).mtimeMs).toBe(written)
    expect(readFileSync(manifestPath('echoer'), 'utf8')).toBe(text)
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['echoer'])
    expect(JSON.parse(store.settings.appSetting(LEGACY_KEY)!)).toEqual([{ name: 'centralu', command: 'npx', args: ['-y', 'whatever'] }])

    // The Assistant receives the migrated app, and the legacy entry is loaded raw nowhere
    await mgr.assistant()
    expect(attached(adapter.last())).toEqual(['app-echoer'])
    expect(adapter.last()).not.toHaveProperty('extraMcpServers')
  })

  it('once everything is migrated, the legacy key disappears', async () => {
    store.settings.setAppSetting(LEGACY_KEY, JSON.stringify([{ name: 'echoer', ...SERVER }]))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(store.settings.appSetting(LEGACY_KEY)).toBeNull()
  })

  it('if a different app with the same id already exists, does not overwrite it, and keeps the entry', async () => {
    plantApp(join(dataRoot, 'apps'), 'echoer', { server: SERVER })
    const mine = readFileSync(manifestPath('echoer'), 'utf8')
    const theirs = { name: 'echoer', command: 'npx', args: ['-y', 'other-server'] }
    store.settings.setAppSetting(LEGACY_KEY, JSON.stringify([theirs]))
    connect()
    expect(readFileSync(manifestPath('echoer'), 'utf8')).toBe(mine)
    expect(JSON.parse(store.settings.appSetting(LEGACY_KEY)!)).toEqual([theirs])
  })
})

describe('removal (apps.remove, A-7)', () => {
  it('removing a user-folder app drops it from the list and the Assistant, and its folder goes to app-trash', async () => {
    connect()
    const { orc } = await proposeAndApprove('echoer')
    const apps = live(orc.id)
    await apps.call('app-echoer', 'peek', {})

    await rpc('apps.remove', { appId: 'echoer', projectId: null })

    expect(userApps()).toEqual([])
    expect(existsSync(join(dataRoot, 'apps', 'echoer'))).toBe(false)
    expect(readdirSync(join(dataRoot, 'app-trash'))).toEqual([expect.stringMatching(/^echoer-\d+$/)])
    // The session has it no more
    expect(apps.current().map((a) => a.server)).toEqual([])
    // Even a call that still names it is refused
    const late = await apps.call('app-echoer', 'poke', { to: 1 })
    expect(late.isError).toBe(true)
    expect(JSON.stringify(late.content)).toContain('This session has no app named echoer')
    // The removed app's run record stays
    expect(rt.runs({ projectId: null, appId: 'echoer' })).toEqual([expect.objectContaining({ tool: 'peek', callerSessionId: orc.id })])
    // The same name can be proposed again
    const again = await mgr.runCentraluTool(orc.id, 'propose_mcp_server', { name: 'echoer', ...SERVER })
    expect(again.isError).toBeFalsy()
  })

  it('a project app is not removed — it is a file in the repository, so git is the place to clean it up', async () => {
    connect()
    plantApp(join(repo, ...PROJECT_APPS), 'notes', { server: SERVER })
    const projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
    await expect(rpc('apps.remove', { appId: 'notes', projectId })).rejects.toThrow(/part of the project's repository/)
    expect(existsSync(join(repo, ...PROJECT_APPS, 'notes'))).toBe(true)
    expect(rt.list().map((a) => a.appId)).toEqual(['notes'])
  })
})
