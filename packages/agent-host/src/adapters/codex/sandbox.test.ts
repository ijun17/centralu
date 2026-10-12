import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  requests: [] as { method: string; params?: Record<string, unknown> }[],
  sandbox: undefined as Record<string, unknown> | undefined,
  config: {} as Record<string, unknown>,
}))
vi.mock('./client.js', () => ({
  CodexClient: class {
    async request(method: string, params?: Record<string, unknown>) {
      state.requests.push({ method, params })
      if (method === 'config/read') return { config: state.config }
      if (method === 'thread/start' || method === 'thread/resume') {
        return { thread: { id: 'thread-582' }, sandbox: state.sandbox }
      }
      return {}
    }
    notify() {}
    async dispose() {}
  },
}))
const { CodexAdapter } = await import('./index.js')

let root: string
let main: string
let worktree: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
beforeEach(() => {
  state.requests.length = 0
  state.sandbox = undefined
  state.config = {}
  // .native: on Windows it expands 8.3 short names (RUNNER~1), as git's own paths are
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-codex-sandbox-')))
  main = join(root, 'main')
  worktree = join(root, 'child')
  mkdirSync(main)
  git(main, 'init', '-q')
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial')
  git(main, 'worktree', 'add', '-qb', 'child', worktree)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Codex worktree sandbox (#582)', () => {
  for (const preset of ['safe', 'normal', 'auto'] as const) {
    for (const resume of [false, true]) {
      it(`${preset} ${resume ? 'resume' : 'start'}: includes the common git dir and network only for auto`, async () => {
        const h = await new CodexAdapter().createSession({
          sessionId: 's1', cwd: worktree, permissionPreset: preset, projectTrusted: true,
          ...(resume ? { resumeExternalId: 'thread-582' } : {}),
        }, () => {})
        const params = state.requests.find((r) => r.method === (resume ? 'thread/resume' : 'thread/start'))!.params!
        expect(params.config).toMatchObject({
          'sandbox_workspace_write.writable_roots': [join(main, '.git')],
          'sandbox_workspace_write.network_access': preset === 'auto',
        })
        expect(params.approvalPolicy).toBe(preset === 'safe' ? 'untrusted' : preset === 'auto' ? 'never' : undefined)
        expect(params.sandbox).toBe(preset === 'normal' ? undefined : 'workspace-write')
        await h.dispose()
      })
    }
  }

  it('resolves a worktree reached through a symlink, including a cwd below its root', async () => {
    mkdirSync(join(worktree, 'package'))
    symlinkSync(worktree, join(root, 'alias'), 'dir')
    const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: join(root, 'alias', 'package'), permissionPreset: 'auto' }, () => {})
    expect(state.requests.find((r) => r.method === 'thread/start')!.params!.config).toMatchObject({
      'sandbox_workspace_write.writable_roots': [join(main, '.git')],
    })
    await h.dispose()
  })

  it('adds the common git dir without discarding or duplicating the person\'s extra writable roots', async () => {
    state.config = { sandbox_workspace_write: { writable_roots: [root, join(main, '.git')] } }
    const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: worktree, permissionPreset: 'normal', projectTrusted: true }, () => {})
    expect(state.requests.find((r) => r.method === 'thread/start')!.params!.config).toMatchObject({
      'sandbox_workspace_write.writable_roots': [join(main, '.git'), root],
    })
    expect(state.requests.find((r) => r.method === 'config/read')!.params).toEqual({ cwd: worktree })
    await h.dispose()
  })

  for (const cwdKind of ['main', 'non-git'] as const) {
    it(`${cwdKind}: adds no git writable root`, async () => {
      const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: cwdKind === 'main' ? main : root, permissionPreset: 'safe' }, () => {})
      expect(state.requests.find((r) => r.method === 'thread/start')!.params!.config).not.toHaveProperty('sandbox_workspace_write.writable_roots')
      await h.dispose()
    })
  }

  for (const preset of ['safe', 'normal'] as const) {
    it(`reports the effective network restriction under ${preset} to a delegating parent`, async () => {
      state.sandbox = { type: 'workspaceWrite', networkAccess: false }
      const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: worktree, permissionPreset: preset }, () => {})
      expect(h.delegationNotice?.()).toBe(`this child cannot reach the network under ${preset}`)
      await h.dispose()
    })
  }

  it('normal preserves a personal full-access sandbox and does not claim its network is blocked', async () => {
    state.sandbox = { type: 'dangerFullAccess' }
    const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: worktree, permissionPreset: 'normal' }, () => {})
    expect(h.delegationNotice?.()).toBeUndefined()
    await h.dispose()
  })
})
