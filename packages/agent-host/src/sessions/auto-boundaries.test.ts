import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/** Every opened host boundary reads the caller's own preset; no global or project grant is manufactured. */
describe('auto Centralu boundaries (#603)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
    vi.restoreAllMocks()
  })
  const session = async (permissionPreset: PermissionPreset = 'auto', askedBy?: string) =>
    (
      await w.mgr.createSession({
        projectId: w.caller.id,
        cwd: w.caller.path,
        tool: 'claude',
        permissionPreset,
        askedBy,
      })
    ).id
  const handle = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const start = (id: string) =>
    w.mgr.startAgent(id, { task: 'check', wait: false }, AbortSignal.timeout(1000))

  it('allows and logs start and both project consents without cards or remembered grants', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = await session()
    expect(await start(id)).toMatchObject({ ok: true, state: 'working' })
    for (const access of ['delegate', 'apps'] as const) {
      expect(
        await w.mgr.ensureProjectAccess(
          id,
          w.target.id,
          access,
          { text: 'check' },
          AbortSignal.timeout(1000),
        ),
      ).toEqual({ ok: true })
    }
    expect(w.events.filter((e) => e.type === 'approval_request')).toEqual([])
    expect(w.mgr.projectConsents()).toEqual([])
    expect(log.mock.calls.flat().join('\n')).toContain('agent_start allowed')
    expect(log.mock.calls.flat().join('\n')).toContain('target not trusted')
  })

  it.each(['safe', 'normal'] as const)(
    '%s still asks at start and each cross-project consent',
    async (preset) => {
      const id = await session(preset)
      const pending = start(id)
      await w.until(() => !!w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval)
      const card = w.mgr.listSessions().find((s) => s.id === id)!.pendingApproval!
      w.mgr.respondApproval(id, card.requestId, 'deny')
      expect((await pending).ok).toBe(false)
      for (const access of ['delegate', 'apps'] as const) {
        const call = w.mgr.ensureProjectAccess(id, w.target.id, access, { text: 'check' })
        await w.until(() => !!w.card(id))
        w.mgr.respondApproval(id, w.card(id)!.requestId, 'deny')
        expect((await call).ok).toBe(false)
      }
    },
  )

  it('auto children cascade into agents and projects, including untrusted callers and targets', async () => {
    const parent = await session()
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const first = await start(parent)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    w.mgr.setProjectTrusted(w.caller.id, false)
    const grandchild = await start(first.sessionId)
    expect(grandchild).toMatchObject({ ok: true, state: 'working' })
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    const asking = w.mgr.askProject(
      first.sessionId,
      { project: w.target.id, task: 'check' },
      AbortSignal.timeout(1000),
    )
    expect(target.permissionPreset).toBe('normal')
    await w.until(() => !!handle(target.id)?.sent.length)
    handle(target.id).answer('checked')
    expect(await asking).toMatchObject({ ok: true, answer: 'checked' })
    expect(w.events.filter((e) => e.type === 'approval_request')).toEqual([])
    expect(
      w.mgr
        .listSessions()
        .filter((s) => s.askedBy)
        .every((s) => s.permissionPreset === 'auto'),
    ).toBe(true)
  })

  it.each(['safe', 'normal'] as const)(
    '%s: ask_project preserves the target preset',
    async (preset) => {
      const id = await session(preset)
      w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const child = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'auto' })
      const call = w.mgr.askProject(id, { project: w.target.id, task: 'check' }, AbortSignal.timeout(1000))
      expect(child.permissionPreset).toBe('auto')
      await w.until(() => !!handle(child.id)?.sent.length)
      handle(child.id).answer('done')
      expect((await call).ok).toBe(true)
    },
  )

  it.each(['safe', 'normal'] as const)('%s refuses depth and untrusted delegation', async (preset) => {
    const parent = await session('auto')
    const child = await session(preset, parent)
    expect(await start(child)).toMatchObject({ ok: false, error: expect.stringContaining('itself started') })
    expect(await w.mgr.askProject(child, { project: w.target.id, task: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('itself started'),
    })
    const own = await session(preset)
    w.mgr.setProjectTrusted(w.caller.id, false)
    expect(await start(own)).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
    expect(await w.mgr.askProject(own, { project: w.target.id, task: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not trusted'),
    })
  })

  it('reads changes to the caller preset and never remembers an auto consent', async () => {
    const id = await session()
    expect(await w.mgr.ensureProjectAccess(id, w.target.id, 'apps', { text: 'x' })).toEqual({ ok: true })
    await w.mgr.updateSettings(id, { permissionPreset: 'safe' })
    const call = w.mgr.ensureProjectAccess(id, w.target.id, 'apps', { text: 'x' })
    await w.until(() => !!w.card(id))
    w.mgr.respondApproval(id, w.card(id)!.requestId, 'deny')
    expect((await call).ok).toBe(false)
  })

  it("opens ownership for every same-project action, including another parent's running child", async () => {
    const owner = await session()
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const caller = await session()
    const child = await start(owner)
    if (!child.ok) throw new Error(child.error)
    expect(await w.mgr.agentSession(caller, { sessionId: child.sessionId, action: 'status' })).toMatchObject({
      ok: true,
      state: 'working',
    })
    expect(
      await w.mgr.agentSession(caller, { sessionId: child.sessionId, action: 'send', text: 'note' }),
    ).toMatchObject({ ok: true, state: 'working' })
    const wait = w.mgr.agentSession(caller, { sessionId: child.sessionId, action: 'wait' })
    handle(child.sessionId).answer('done')
    expect(await wait).toMatchObject({ ok: true, state: 'done', answer: 'done' })
    await w.mgr.send(child.sessionId, 'a person starts a turn')
    expect(await w.mgr.agentSession(caller, { sessionId: child.sessionId, action: 'stop' })).toMatchObject({
      ok: true,
      state: 'stopped',
    })
    expect(handle(child.sessionId).interrupted).toBe(1)
    const otherProject = await w.mgr.createSession({
      projectId: w.target.id,
      cwd: w.target.path,
      tool: 'claude',
      permissionPreset: 'auto',
    })
    expect((await w.mgr.agentSession(caller, { sessionId: otherProject.id, action: 'status' })).ok).toBe(
      false,
    )
  })

  it.each(['safe', 'normal'] as const)('%s refuses another owner and higher presets', async (preset) => {
    const caller = await session(preset)
    const other = await session()
    for (const action of ['status', 'send', 'wait', 'stop', 'delete'] as const) {
      expect((await w.mgr.agentSession(caller, { sessionId: other, action, text: 'x' })).ok).toBe(false)
    }
    const own = await session('auto', caller)
    expect(await w.mgr.agentSession(caller, { sessionId: own, action: 'send', text: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('more permissions'),
    })
  })

  it('defaults to unlimited for auto; configured ceilings apply at every count and survive saving', async () => {
    const id = await session()
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    // Sweep zero through twice the old ceiling, including its immediate neighbours.
    for (let n = 0; n < 9; n++) expect((await start(id)).ok).toBe(true)
    for (let ceiling = 1; ceiling <= 9; ceiling++) {
      w.mgr.setUiPreferences({ agentCeiling: ceiling })
      expect(w.mgr.uiPreferences().agentCeiling).toBe(ceiling)
      expect(await start(id)).toMatchObject({ ok: false, error: expect.stringContaining('9 agents') })
    }
    w.mgr.setUiPreferences({ agentCeiling: 10 })
    expect((await start(id)).ok).toBe(true)
    w.mgr.setUiPreferences({ agentCeiling: 0 })
    expect((await start(id)).ok).toBe(true)
    w.mgr.setUiPreferences({ agentCeiling: null })
    expect((await start(id)).ok).toBe(true)
  })

  it.each(['safe', 'normal'] as const)(
    '%s defaults to four and can use an explicit unlimited setting',
    async (preset) => {
      const id = await session(preset)
      w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      for (let n = 0; n < 4; n++) expect((await start(id)).ok).toBe(true)
      expect((await start(id)).ok).toBe(false)
      w.mgr.setUiPreferences({ agentCeiling: 0 })
      expect((await start(id)).ok).toBe(true)
    },
  )

  it.each(['auto', 'safe', 'normal'] as const)(
    '%s: dirty and unproven worktree cleanup follows the caller preset',
    async (preset) => {
      for (const state of ['dirty', 'unmerged']) {
        const git = (cwd: string, ...args: string[]) =>
          execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
            cwd,
            encoding: 'utf8',
          }).trim()
        if (state === 'dirty') {
          git(w.caller.path, 'init', '-q', '-b', 'main')
          writeFileSync(join(w.caller.path, 'README.md'), 'initial')
          git(w.caller.path, 'add', '.')
          git(w.caller.path, 'commit', '-qm', 'init')
        }
        const caller = await session(preset)
        const child = await w.mgr.createSession({
          projectId: w.caller.id,
          cwd: w.caller.path,
          tool: 'claude',
          permissionPreset: 'auto',
          worktree: true,
          worktreeBranch: `feat/${state}`,
          askedBy: caller,
        })
        writeFileSync(join(child.worktree!.path, 'wip.txt'), 'new work')
        if (state === 'unmerged') {
          git(child.worktree!.path, 'add', '.')
          git(child.worktree!.path, 'commit', '-qm', 'unmerged')
        }
        const result = await w.mgr.agentSession(caller, { sessionId: child.id, action: 'delete' })
        if (preset === 'auto')
          expect(result).toMatchObject({ ok: true, state: 'deleted', proof: 'auto preset' })
        else
          expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining(state === 'dirty' ? 'uncommitted changes' : 'Could not prove'),
          })
        expect(existsSync(child.worktree!.path)).toBe(preset !== 'auto')
        expect(git(w.caller.path, 'branch', '--list', child.worktree!.branch).length > 0).toBe(
          preset !== 'auto',
        )
        expect(w.mgr.listSessions().some((s) => s.id === child.id)).toBe(preset !== 'auto')
      }
    },
  )
})
