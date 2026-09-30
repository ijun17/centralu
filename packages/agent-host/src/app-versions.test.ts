import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type AppVersions, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { ExternalApps } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'

/**
 * App versions — from the RPC door (M4 E-1). For a project app, git is the version history, so
 * the host's core reads and shows **only the commits that touched that app's folder** (restoring
 * is done with git). For a user-folder app, versions are the runtime's snapshots. A real
 * repository (git init), a real runtime.
 */

let root = ''
let repo = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd: repo })

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-versions-')))
  repo = join(root, 'repo')
  mkdirSync(join(root, 'data'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  mgr = new SessionManager(store, adapters, () => {})
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(root, 'data'), reservedIds: [] })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('apps.versions', () => {
  it('a project app is the recent commits that touched its app folder — other commits are not mixed in', async () => {
    plantApp(join(repo, ...PROJECT_APPS), 'notes')
    git('add', '.')
    git('commit', '-qm', 'Add the notes app')
    writeFileSync(join(repo, 'README.md'), 'unrelated\n')
    git('add', '.')
    git('commit', '-qm', 'Unrelated change')
    writeFileSync(join(repo, '.centralu', 'apps', 'notes', 'server.mjs'), '// tweak\n')
    git('add', '.')
    git('commit', '-qm', 'Tweak the notes app')
    rt.refresh()

    const v = (await rpc('apps.versions', { appId: 'notes', projectId })) as AppVersions
    // The answer matches the protocol shape exactly — internal fields like a snapshot's fingerprint
    // do not leak through
    expect(RpcMethods['apps.versions'].result.safeParse(v).success).toBe(true)
    expect(v.kind).toBe('git')
    if (v.kind !== 'git') return
    expect(v.repo).toBe(true)
    expect(v.commits.map((c) => [c.subject, c.author])).toEqual([
      ['Tweak the notes app', 'Tester'],
      ['Add the notes app', 'Tester'],
    ])
    // Restoring is done with git — the host refuses
    await expect(rpc('apps.restoreVersion', { appId: 'notes', projectId, id: v.commits[1]!.sha })).rejects.toThrow(
      "A project app's versions are its git history; restore it with git",
    )
  })

  it('a non-repository project is repo: false with an empty list, and a user-folder app is snapshots', async () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    plantApp(join(repo, ...PROJECT_APPS), 'notes')
    plantApp(join(root, 'data', 'apps'), 'mine')
    rt.refresh()
    expect(await rpc('apps.versions', { appId: 'notes', projectId })).toEqual({ kind: 'git', repo: false, commits: [] })
    expect(await rpc('apps.versions', { appId: 'mine', projectId: null })).toEqual({ kind: 'snapshots', snapshots: [] })
    // If a snapshot version was taken, that entry carries only the protocol's fields (the full
    // fingerprint stays inside the host)
    await rt.call({ projectId: null, appId: 'mine' }, 'echo', { text: 'x' }, { kind: 'view' }).catch(() => {})
    const snaps = (await rpc('apps.versions', { appId: 'mine', projectId: null })) as AppVersions
    expect(RpcMethods['apps.versions'].result.safeParse(snaps).success).toBe(true)
    if (snaps.kind === 'snapshots') for (const s of snaps.snapshots) expect(Object.keys(s).sort()).toEqual(['at', 'bytes', 'current', 'files', 'id', 'reason'])
  })
})
