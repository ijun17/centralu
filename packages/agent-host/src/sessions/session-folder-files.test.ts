/**
 * A worktree session's files are read from its worktree (#1209), through the RPC door the viewer uses.
 *
 * `fs.readFile` and `fs.resolve` were keyed by the project only, so a link in a worktree session's reply opened the
 * main checkout's file: the old version of a file the agent changed, or "not found" for one only on its branch. With
 * the session named, the host reads from that session's folder and refuses anything outside it, the main checkout
 * included (docs/security-boundaries.md, "Project files and native handoff").
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FsFile, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { managerWorld } from './manager.test-helpers.js'

let root = ''
let repo = ''
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd })

const create = (worktree: boolean, pid = projectId) =>
  rpc('agents.createSession', { projectId: pid, cwd: repo, tool: 'claude', worktree }) as Promise<SessionInfo>

const read = (path: string, sessionId?: string) =>
  rpc('fs.readFile', { projectId, path, ...(sessionId ? { sessionId } : {}) }) as Promise<FsFile>

beforeEach(async () => {
  const world = managerWorld()
  // native: the host answers with the expanded spelling of a Windows short name (#14)
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-session-folder-')))
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'main\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'init'])

  const adapters = new Map<ToolName, AgentAdapter>([['claude', world.adapter]])
  const mgr = new SessionManager(world.store, adapters, (e) => world.events.push(e), undefined, join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rpc = createRpcHandler(mgr, adapters)
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  // A worktree is only made in a trusted project (#407)
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

// Retried: a manager starts git in the repository on its own and Windows will not delete a folder in use (#14)
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

describe("a session's files (#1209)", () => {
  it("reads a worktree session's file from its worktree, and the project's without the session", async () => {
    const s = await create(true)
    const wt = s.worktree!.path
    writeFileSync(join(wt, 'a.txt'), 'branch\n')
    writeFileSync(join(wt, 'only-on-branch.txt'), 'new\n')

    expect((await read('a.txt', s.id)).text).toBe('branch\n')
    expect((await read('only-on-branch.txt', s.id)).text).toBe('new\n')
    // The absolute path a reply prints is read from the same folder
    expect((await read(join(wt, 'a.txt'), s.id)).text).toBe('branch\n')
    // Without the session the call is what it always was: the project's own checkout
    expect((await read('a.txt')).text).toBe('main\n')
    await expect(read('only-on-branch.txt')).rejects.toThrow()
  })

  it("refuses a path outside the session's worktree, the main checkout included", async () => {
    const s = await create(true)
    const wt = s.worktree!.path
    await expect(read(join(repo, 'a.txt'), s.id)).rejects.toThrow(/outside/i)
    await expect(read(relative(wt, join(repo, 'a.txt')), s.id)).rejects.toThrow(/outside/i)
    await expect(read('../x.txt', s.id)).rejects.toThrow(/outside/i)
  })

  it('reads a session without a worktree from the project', async () => {
    const s = await create(false)
    expect((await read('a.txt', s.id)).text).toBe('main\n')
  })

  it("refuses a session that is not the project's, and one the host does not know", async () => {
    const otherPath = join(root, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', otherPath], { cwd: root })
    const other = (await rpc('projects.add', { path: otherPath })) as { id: string }
    const s = await create(false, other.id)
    await expect(read('a.txt', s.id)).rejects.toThrow(/not a session of this project/)
    await expect(read('a.txt', 'no-such-session')).rejects.toMatchObject({ code: 'session_not_found' })
  })

  it("resolves a worktree session's file in its worktree for reveal and open, never for the trash", async () => {
    const s = await create(true)
    const wt = s.worktree!.path
    const resolve = (purpose?: string) =>
      rpc('fs.resolve', { projectId, path: 'a.txt', sessionId: s.id, ...(purpose ? { purpose } : {}) }) as Promise<{ path: string }>
    expect(realpathSync.native((await resolve()).path)).toBe(realpathSync.native(join(wt, 'a.txt')))
    expect(realpathSync.native((await resolve('reveal')).path)).toBe(realpathSync.native(join(wt, 'a.txt')))
    await expect(resolve('trash')).rejects.toThrow(/not resolved for trash/)
    await expect(resolve('project')).rejects.toThrow(/not resolved for project/)
    // The worktree folder itself is not handed to the OS, as the project folder is not
    await expect(
      rpc('fs.resolve', { projectId, path: '.', sessionId: s.id }),
    ).rejects.toThrow()
  })
})
