import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption, PermissionPreset } from '@cc/protocol'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

const DEPTH_SETTING = 'How deep agents may start agents'

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
    '%s still asks at each cross-project consent; at start, safe asks and normal in a trusted project does not (#673)',
    async (preset) => {
      const id = await session(preset)
      if (preset === 'safe') {
        const pending = start(id)
        await w.until(() => !!w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval)
        const card = w.mgr.listSessions().find((s) => s.id === id)!.pendingApproval!
        w.mgr.respondApproval(id, card.requestId, 'deny')
        expect((await pending).ok).toBe(false)
      } else {
        expect(await start(id)).toMatchObject({ ok: true })
        expect(w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval).toBeFalsy()
      }
      for (const access of ['delegate', 'apps'] as const) {
        const call = w.mgr.ensureProjectAccess(id, w.target.id, access, { text: 'check' })
        await w.until(() => !!w.card(id))
        w.mgr.respondApproval(id, w.card(id)!.requestId, 'deny')
        expect((await call).ok).toBe(false)
      }
    },
  )

  it('auto children cascade into agents and projects, including untrusted callers and targets, as deep as the agent depth', async () => {
    // A child starts agents and asks projects only from an agent depth of 2 (#867)
    w.mgr.setUiPreferences({ agentDepth: 2 })
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
    expect(await start(child)).toMatchObject({ ok: false, error: expect.stringContaining(DEPTH_SETTING) })
    expect(await w.mgr.askProject(child, { project: w.target.id, task: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining(DEPTH_SETTING),
    })
    const own = await session(preset)
    w.mgr.setProjectTrusted(w.caller.id, false)
    expect(await start(own)).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
    expect(await w.mgr.askProject(own, { project: w.target.id, task: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not trusted'),
    })
  })

  /*
   * How deep agents may start agents (#867). `auto` used to open this boundary: round-4 refactor sessions under auto each
   * started sessions of their own, twelve ran at once and the load average reached 216 (#862). Now a setting, 1 by
   * default, that no preset crosses.
   */
  describe('the agent depth (#867)', () => {
    const levelsBelow = (n: number) => `This session is ${n} level${n === 1 ? '' : 's'} below a session the person started`
    /** An auto chain from a session the person started down to `depth`; the last one's id */
    const chainTo = async (depth: number) => {
      let id = await session('auto')
      for (let level = 1; level <= depth; level++) {
        const r = await start(id)
        if (!r.ok) throw new Error(`level ${level}: ${r.error}`)
        id = r.sessionId
      }
      return id
    }

    it('at the default 1, an auto child cannot start agents nor ask a project, and is told the setting and where it is', async () => {
      expect(w.mgr.uiPreferences().agentDepth).toBeUndefined()
      const child = await chainTo(1)
      const r = await start(child)
      expect(r).toEqual({
        ok: false,
        error: `${levelsBelow(1)}, and "${DEPTH_SETTING}" in Settings → Orchestrator is 1, so it cannot start agents. Say in your answer what is needed instead; the person can raise that setting.`,
      })
      expect(await w.mgr.askProject(child, { project: w.target.id, task: 'x' })).toMatchObject({
        ok: false,
        error: expect.stringContaining(`${levelsBelow(1)}, and "${DEPTH_SETTING}" in Settings → Orchestrator is 1, so it cannot ask a project`),
      })
      expect(w.mgr.listSessions().filter((s) => s.askedBy === child)).toEqual([])
      expect(w.events.filter((e) => e.type === 'approval_request')).toEqual([])
    })

    // Every value, each against the level right above it and the first one at it
    it.each([1, 2, 3])('at %i, auto sessions above it start agents and the first one at it is refused', async (limit) => {
      w.mgr.setUiPreferences({ agentDepth: limit })
      const above = await chainTo(limit - 1)
      const r = await start(above)
      expect(r).toMatchObject({ ok: true, state: 'working' })
      const at = r.ok ? r.sessionId : ''
      expect(await start(at)).toMatchObject({ ok: false, error: expect.stringContaining(`${levelsBelow(limit)}, and "${DEPTH_SETTING}" in Settings → Orchestrator is ${limit}`) })
      expect(w.mgr.listSessions().filter((s) => s.askedBy === at)).toEqual([])
    })

    /*
     * The first gate, before anything is read or asked (#897 review): the later re-read (`agentStartGateError`) refuses
     * the same caller, so only this shows whether the start got as far as the tool's detection, a model check, a card
     * or the consent `auto` opens and logs for it.
     */
    it.each(['auto', 'safe'] as const)('%s: a caller at it is refused before the tool is detected, a model checked or a card raised', async (preset) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      const parent = await session(preset)
      const child = await w.mgr.startAgent(parent, { task: 'check', wait: false }, AbortSignal.timeout(5000))
      if (!child.ok) throw new Error(child.error)
      const claude = w.adapters.get('claude')!
      const detect = vi.spyOn(claude, 'detect')
      const models = vi.fn(async (): Promise<ModelOption[]> => [{ id: 'm', label: 'm', efforts: [], defaultEffort: null, tiers: [] }])
      claude.listModels = models
      log.mockClear()
      expect(await w.mgr.startAgent(child.sessionId, { task: 'deeper', model: 'm', wait: false }, AbortSignal.timeout(5000))).toMatchObject({
        ok: false,
        error: expect.stringContaining(DEPTH_SETTING),
      })
      expect(detect).not.toHaveBeenCalled()
      expect(models).not.toHaveBeenCalled()
      expect(w.mgr.listSessions().find((s) => s.id === child.sessionId)?.pendingApproval).toBeFalsy()
      expect(log.mock.calls.flat().join('\n')).not.toContain('agent_start')
    })

    it('deleting the middle of a chain does not let the grandchild start agents; its depth outlives the parent (#897 review)', async () => {
      w.mgr.setUiPreferences({ agentDepth: 2 })
      const top = await session('auto')
      const middle = await start(top)
      if (!middle.ok) throw new Error(middle.error)
      const bottom = await start(middle.sessionId)
      if (!bottom.ok) throw new Error(bottom.error)
      expect(await start(bottom.sessionId)).toMatchObject({ ok: false, error: expect.stringContaining('2 levels below') })
      await w.mgr.trashSession(middle.sessionId)
      expect(w.mgr.listSessions().some((s) => s.id === middle.sessionId)).toBe(false)
      expect(w.mgr.listSessions().find((s) => s.id === bottom.sessionId)?.askedBy).toBe(middle.sessionId)
      expect(await start(bottom.sessionId)).toMatchObject({ ok: false, error: expect.stringContaining('2 levels below') })
      // The record goes with the session when the trash is emptied of it, and only its own
      expect(await w.store.purgeSession(middle.sessionId)).toBe(true)
      expect(w.store.appSetting(`agent_depth:${middle.sessionId}`)).toBeNull()
      expect(w.store.appSetting(`agent_depth:${bottom.sessionId}`)).toBe('2')
    })

    it('is read at each call: lowering it refuses the next start, raising it allows it again', async () => {
      w.mgr.setUiPreferences({ agentDepth: 3 })
      const grandchild = await chainTo(2)
      w.mgr.setUiPreferences({ agentDepth: 2 })
      expect(await start(grandchild)).toMatchObject({ ok: false, error: expect.stringContaining(DEPTH_SETTING) })
      w.mgr.setUiPreferences({ agentDepth: 3 })
      expect(await start(grandchild)).toMatchObject({ ok: true })
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
      await w.mgr.agentSession(caller, { sessionId: child.sessionId, action: 'send', text: 'note', ifBusy: 'note' }),
    ).toMatchObject({ ok: true, state: 'working', via: 'note' })
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

  /*
   * One worktree per test (#368). Creating a worktree session and deleting it with its work kept is about fifty git
   * processes, and on windows-2022 each takes 100 ms or more: with both states in one test, the safe preset's ran past
   * the 15 s Windows limit (run 38775014188). Auto-maintenance is off, as in manager.test.ts (#503): each commit would
   * start one more git, which goes on working in the repository after the commit returns.
   */
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim()
  it.each([
    ['auto', 'dirty'],
    ['auto', 'unmerged'],
    ['safe', 'dirty'],
    ['safe', 'unmerged'],
    ['normal', 'dirty'],
    ['normal', 'unmerged'],
  ] as const)('%s: %s worktree cleanup keeps local work in the trash (#608)', async (preset, state) => {
    git(w.caller.path, 'init', '-q', '-b', 'main')
    writeFileSync(join(w.caller.path, 'README.md'), 'initial')
    git(w.caller.path, 'add', '.')
    git(w.caller.path, 'commit', '-qm', 'init')
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
    expect(result).toMatchObject({ ok: true, state: 'deleted', setAside: {
      changedFiles: state === 'dirty' ? 1 : 0,
      commits: state === 'unmerged' ? 1 : 0,
    } })
    expect(w.store.trashedSession(child.id)?.record.recovery).toBeDefined()
    expect(existsSync(child.worktree!.path)).toBe(false)
    expect(git(w.caller.path, 'branch', '--list', child.worktree!.branch)).toBe('')
    expect(w.mgr.listSessions().some((s) => s.id === child.id)).toBe(false)
  })
})
