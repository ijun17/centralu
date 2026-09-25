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
 * 앱의 판 — RPC 문에서 (M4 E-1). 프로젝트 앱은 git이 판이라 host의 코어가 **그 앱 폴더를 건드린 커밋만** 읽어 보인다(되돌리기는
 * git으로 한다). 사용자 폴더 앱은 런타임의 스냅샷이다. 진짜 저장소(git init), 진짜 런타임.
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
  it('프로젝트 앱은 그 앱 폴더를 건드린 최근 커밋이다 — 다른 커밋은 끼지 않는다', async () => {
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
    // 답은 프로토콜의 모양 그대로다 — 스냅샷의 지문 같은 안쪽 칸이 새어 나가지 않는다
    expect(RpcMethods['apps.versions'].result.safeParse(v).success).toBe(true)
    expect(v.kind).toBe('git')
    if (v.kind !== 'git') return
    expect(v.repo).toBe(true)
    expect(v.commits.map((c) => [c.subject, c.author])).toEqual([
      ['Tweak the notes app', 'Tester'],
      ['Add the notes app', 'Tester'],
    ])
    // 되돌리기는 git으로 한다 — host는 거절한다
    await expect(rpc('apps.restoreVersion', { appId: 'notes', projectId, id: v.commits[1]!.sha })).rejects.toThrow(
      "A project app's versions are its git history; restore it with git",
    )
  })

  it('저장소가 아닌 프로젝트는 repo: false에 빈 목록이고, 사용자 폴더 앱은 스냅샷이다', async () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    plantApp(join(repo, ...PROJECT_APPS), 'notes')
    plantApp(join(root, 'data', 'apps'), 'mine')
    rt.refresh()
    expect(await rpc('apps.versions', { appId: 'notes', projectId })).toEqual({ kind: 'git', repo: false, commits: [] })
    expect(await rpc('apps.versions', { appId: 'mine', projectId: null })).toEqual({ kind: 'snapshots', snapshots: [] })
    // 떠 둔 판이 있으면 그 줄은 프로토콜의 칸만 싣는다 (지문 전체는 host 안에 남는다)
    await rt.call({ projectId: null, appId: 'mine' }, 'echo', { text: 'x' }, { kind: 'view' }).catch(() => {})
    const snaps = (await rpc('apps.versions', { appId: 'mine', projectId: null })) as AppVersions
    expect(RpcMethods['apps.versions'].result.safeParse(snaps).success).toBe(true)
    if (snaps.kind === 'snapshots') for (const s of snaps.snapshots) expect(Object.keys(s).sort()).toEqual(['at', 'bytes', 'current', 'files', 'id', 'reason'])
  })
})
