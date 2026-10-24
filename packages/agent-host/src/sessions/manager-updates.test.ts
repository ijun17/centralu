/**
 * SessionManager through RPC with an in-memory adapter: agent updates and host switches.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { NormalizedEvent } from '@cc/protocol'
import { CENTRALU_APPLY, CENTRALU_APPLY_QUESTION } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { UpdateService } from '../updates.js'
import { UpdateApplyBroker } from '../update-apply.js'
import { FakeAdapter, managerWorld } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, mgr, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

describe('tool definitions after a host switch (#581)', () => {
  it('restarts a live idle session when its served prefix hash changed', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    store.settings.setAppSetting(`tool_prefix:${session.id}`, 'old-prefix')
    await mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(true)
    expect(adapter.handleOf(session.id)).not.toBe(old)
  })

  it('keeps a process whose served prefix is unchanged', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    await mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(false)
    expect(adapter.handleOf(session.id)).toBe(old)
  })

  it('lets a working turn and its approval finish before refreshing the definitions', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    await rpc('agents.send', { sessionId: session.id, text: 'work' })
    const restart = vi.spyOn(mgr, 'restartSession')
    old.emitApproval('held-card')
    store.settings.setAppSetting(`tool_prefix:${session.id}`, 'old-prefix')
    await mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(false)
    await rpc('agents.respondApproval', { sessionId: session.id, requestId: 'held-card', decision: 'allow' })
    expect(old.disposed).toBe(false)
    old.finishTurn()
    await vi.waitFor(() => expect(adapter.handleOf(session.id)).not.toBe(old))
    expect(old.disposed).toBe(true)
    expect(adapter.lastOpts?.resumeExternalId).toBe('ext-1')
    expect(restart).toHaveBeenCalledWith(session.id, 'instructions')
  })
})

describe('adapter launch settings after a host switch (#589)', () => {
  it('restarts a kept idle process when its adapter launch fingerprint changed', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    adapter.launchFingerprint = 'v2'

    await mgr.refreshToolDefinitions()

    expect(old.disposed).toBe(true)
    expect(adapter.handleOf(session.id)).not.toBe(old)
    expect(store.settings.appSetting(`launch_settings:${session.id}`)).toContain('v2')
  })

  it.each(['idle', 'working'] as const)('restarts a kept %s process with unrecorded launch settings once and reports its own cause', async (state) => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    // A request before the handoff consumes the newly-created session's cold-start note.
    old.emitEvent({ type: 'usage_update', sessionId: session.id, tokens: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 30_000, cacheCreationTokens: 0 }, request: { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 0 } })
    store.settings.deleteAppSetting(`launch_settings:${session.id}`)
    store.settings.deleteAppSetting(`tool_prefix:${session.id}`)
    if (state === 'working') await rpc('agents.send', { sessionId: session.id, text: 'work' })
    const restart = vi.spyOn(mgr, 'restartSession')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mgr.refreshToolDefinitions()
    if (state === 'working') {
      expect(old.disposed).toBe(false)
      old.finishTurn()
      await vi.waitFor(() => expect(adapter.handleOf(session.id)).not.toBe(old))
    }
    expect(old.disposed).toBe(true)
    expect(restart).toHaveBeenCalledWith(session.id, 'launch_settings')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launch settings changed or previously unrecorded'))
    expect(store.settings.appSetting(`launch_settings:${session.id}`)).toContain('v1')
    const current = adapter.handleOf(session.id)!
    current.emitEvent({ type: 'usage_update', sessionId: session.id, tokens: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 30_000 }, request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 } })
    const usage = await rpc('agents.usage', { tool: 'claude' }) as { cache: { windows: { rebuildCauses: Record<string, number> }[] } }
    expect(usage.cache.windows[0]!.rebuildCauses).toEqual({ launch_settings: 1 })

    await mgr.refreshToolDefinitions()
    expect(adapter.handleOf(session.id)).toBe(current)
    expect(restart).toHaveBeenCalledTimes(1)
    restart.mockRestore()
    log.mockRestore()
  })

  it('keeps a retained process when its adapter launch fingerprint is unchanged', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!

    await mgr.refreshToolDefinitions()

    expect(old.disposed).toBe(false)
    expect(adapter.handleOf(session.id)).toBe(old)
  })

  it('waits for a working retained process before applying changed adapter launch settings', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    await rpc('agents.send', { sessionId: session.id, text: 'work' })
    adapter.launchFingerprint = 'v2'

    await mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(false)

    old.finishTurn()
    await vi.waitFor(() => expect(adapter.handleOf(session.id)).not.toBe(old))
    expect(old.disposed).toBe(true)
  })
})

describe('ordinary session update consent (#581)', () => {
  it.each(['auto', 'safe', 'normal'] as const)('%s: update_centralu opens only for auto, without remembering consent or changing update preferences', async (preset) => {
    const updates = new UpdateService(() => {}, { fetchLatest: async () => ({ ok: true as const, version: '9999.0.0' }), run: async () => {}, installedCopy: () => null })
    const check = vi.spyOn(updates, 'check')
    const apply = vi.spyOn(updates, 'apply').mockImplementation(async () => ({ ...updates.current(), phase: 'updating' as const }))
    const autoApply = vi.spyOn(updates, 'setAutoApply')
    mgr.useUpdates(updates)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: preset })
    for (const action of ['check', 'install'] as const) {
      const call = mgr.runOrchestratorTool(session.id, 'update_centralu', { action })
      if (preset !== 'auto') {
        await vi.waitFor(() => expect(mgr.listSessions().find((s) => s.id === session.id)?.pendingApproval?.detail.kind).toBe('centralu_update'))
        mgr.respondApproval(session.id, mgr.listSessions().find((s) => s.id === session.id)!.pendingApproval!.requestId, 'deny')
      }
      expect((await call).isError === true).toBe(preset !== 'auto')
    }
    expect(check).toHaveBeenCalledTimes(preset === 'auto' ? 1 : 0)
    expect(apply).toHaveBeenCalledTimes(preset === 'auto' ? 1 : 0)
    expect(autoApply).not.toHaveBeenCalled()
    if (preset === 'auto') {
      await mgr.updateSettings(session.id, { permissionPreset: 'normal' })
      const call = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'check' })
      await vi.waitFor(() => expect(mgr.listSessions().find((s) => s.id === session.id)?.pendingApproval).toBeTruthy())
      mgr.respondApproval(session.id, mgr.listSessions().find((s) => s.id === session.id)!.pendingApproval!.requestId, 'deny')
      expect((await call).isError).toBe(true)
    }
  })

  it('blocks denial, asks again after allow once, and keeps always within the calling session', async () => {
    const fetchLatest = vi.fn(async () => ({ ok: true as const, version: '9999.0.0' }))
    const updates = new UpdateService(() => {}, { fetchLatest, run: async () => {}, installedCopy: () => null })
    const apply = vi.spyOn(updates, 'apply')
    const setAutoApply = vi.spyOn(updates, 'setAutoApply')
    mgr.useUpdates(updates)
    const project = await addProject()
    const first = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const second = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const answer = async (sessionId: string, decision: 'deny' | 'allow' | 'always') => {
      let requestId = ''
      await vi.waitFor(() => {
        const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
        expect(pending?.detail.kind).toBe('centralu_update')
        requestId = pending!.requestId
      })
      // Even a project-scoped answer must remain session-only for updating Centralu.
      await rpc('agents.respondApproval', { sessionId, requestId, decision, scope: 'project' })
    }

    const denied = mgr.runOrchestratorTool(first.id, 'update_centralu', { action: 'check' })
    expect(fetchLatest).not.toHaveBeenCalled()
    await answer(first.id, 'deny')
    expect((await denied).isError).toBe(true)
    expect(fetchLatest).not.toHaveBeenCalled()

    const once = mgr.runOrchestratorTool(first.id, 'update_centralu', { action: 'check' })
    await answer(first.id, 'allow')
    expect((await once).isError).toBeUndefined()
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    const always = mgr.runOrchestratorTool(first.id, 'update_centralu', { action: 'check' })
    await answer(first.id, 'always')
    await always
    await mgr.runOrchestratorTool(first.id, 'update_centralu', { action: 'install' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(setAutoApply).not.toHaveBeenCalled()
    expect(updates.current().autoApply).toBe(false)
    expect(store.permissions.listProjectConsents()).toEqual([])

    const other = mgr.runOrchestratorTool(second.id, 'update_centralu', { action: 'check' })
    await answer(second.id, 'deny')
    expect((await other).isError).toBe(true)
  })
})

describe('applying an installed update for an agent (#665)', () => {
  /**
   * One window, played by the test: it answers each request the way the store does (ready or not) and, told to go,
   * counts a relaunch and reports it started. `ready: false` with a reason stands for "nothing installed".
   */
  function windowWith(verdict: { ready: true; version?: string } | { ready: false; reason: string }) {
    const relaunches: string[] = []
    const asked: NormalizedEvent[] = []
    const tickets = new Map<string, string>()
    const broker: UpdateApplyBroker = new UpdateApplyBroker({
      windows: () => 1,
      answerMs: 2_000,
      push: (e) => {
        asked.push(e)
        queueMicrotask(() => {
          if (e.type === 'update_apply_request') {
            const { ticket } = broker.answer(1, { requestId: e.requestId, ...verdict })
            if (ticket) tickets.set(e.requestId, ticket)
          }
          if (e.type === 'update_apply_go' && tickets.get(e.requestId) === e.ticket) {
            relaunches.push(e.ticket)
            broker.report(1, { requestId: e.requestId, ticket: e.ticket })
          }
        })
      },
    })
    mgr.useUpdateApply(broker)
    return { relaunches, asked }
  }
  const card = (id: string) => mgr.listSessions().find((s) => s.id === id)?.pendingApproval ?? undefined

  it('auto: reaches a window, which relaunches, with no card', async () => {
    const w = windowWith({ ready: true, version: '9.9.9' })
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'auto' })
    const out = await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(out.isError).toBeUndefined()
    expect(out.text).toContain('relaunching into 9.9.9')
    expect(w.relaunches).toHaveLength(1)
    expect(card(session.id)).toBeUndefined()
  })

  it('normal: raises a card first, and relaunches only after the person allows', async () => {
    const w = windowWith({ ready: true })
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const call = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    await vi.waitFor(() => expect(card(session.id)?.detail).toEqual({ kind: 'other', raw: CENTRALU_APPLY_QUESTION, about: CENTRALU_APPLY }))
    expect(w.relaunches).toEqual([])
    mgr.respondApproval(session.id, card(session.id)!.requestId, 'allow')
    expect((await call).isError).toBeUndefined()
    expect(w.relaunches).toHaveLength(1)

    // "Always" on the apply card covers the next apply of this session, with no card
    const always = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    await vi.waitFor(() => expect(card(session.id)).toBeTruthy())
    mgr.respondApproval(session.id, card(session.id)!.requestId, 'always', 'project')
    expect((await always).isError).toBeUndefined()
    expect((await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })).isError).toBeUndefined()
    expect(card(session.id)).toBeUndefined()
    expect(store.permissions.listProjectConsents()).toEqual([])
    expect(w.relaunches).toHaveLength(3)
    const other = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })

    // Denied: nothing goes to the window, and the agent is told not to ask again
    const denied = mgr.runOrchestratorTool(other.id, 'update_centralu', { action: 'apply' })
    await vi.waitFor(() => expect(card(other.id)).toBeTruthy())
    mgr.respondApproval(other.id, card(other.id)!.requestId, 'deny')
    expect(await denied).toMatchObject({ isError: true, text: expect.stringContaining('did not allow') })
    expect(w.relaunches).toHaveLength(3)
    expect(w.asked.filter((e) => e.type === 'update_apply_go')).toHaveLength(3)
  })

  it("normal: an earlier install's always does not cover applying", async () => {
    windowWith({ ready: true })
    const updates = new UpdateService(() => {}, { fetchLatest: async () => ({ ok: true as const, version: '9999.0.0' }), run: async () => {}, installedCopy: () => null })
    vi.spyOn(updates, 'apply').mockImplementation(async () => ({ ...updates.current(), phase: 'updating' as const }))
    mgr.useUpdates(updates)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const install = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'install' })
    await vi.waitFor(() => expect(card(session.id)).toBeTruthy())
    mgr.respondApproval(session.id, card(session.id)!.requestId, 'always')
    await install
    const apply = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    await vi.waitFor(() => expect(card(session.id)?.detail).toEqual({ kind: 'other', raw: CENTRALU_APPLY_QUESTION, about: CENTRALU_APPLY }))
    mgr.respondApproval(session.id, card(session.id)!.requestId, 'deny')
    expect((await apply).isError).toBe(true)
  })

  // #1509 (owner, 2026-10-24): with Automatic updates on and nothing else running, the window would relaunch by itself, so no card
  it('normal: with Automatic updates on and the host at rest, relaunches with no card, apart from the asking session', async () => {
    const w = windowWith({ ready: true, version: '9.9.9' })
    const asked: string[] = []
    mgr.useUpdateAtRest((besides) => (asked.push(besides), true))
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const out = await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(out.isError).toBeUndefined()
    expect(out.text).toContain('relaunching into 9.9.9')
    expect(w.relaunches).toHaveLength(1)
    expect(card(session.id)).toBeUndefined()
    // The caller's own turn is not "busy": the host's answer is asked for this session, at the consent and again right before the relaunch
    expect(asked).toEqual([session.id, session.id])
    // Nothing is remembered: it is judged at each apply
    expect(mgr['updatesAsked'].updateApplyConsents.has(session.id)).toBe(false)
  })

  it('normal: something that starts while the windows are asked stops the card-free relaunch', async () => {
    const w = windowWith({ ready: true })
    let looks = 0
    mgr.useUpdateAtRest(() => ++looks === 1)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const out = await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('Something started running') })
    expect(w.relaunches).toEqual([])
    expect(card(session.id)).toBeUndefined()
  })

  it('normal: the go it sends with no card says so, for the window to wait out typing', async () => {
    const w = windowWith({ ready: true })
    mgr.useUpdateAtRest(() => true)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(w.asked.find((e) => e.type === 'update_apply_go')).toMatchObject({ unasked: true })
  })

  it('normal: asks as before when the setting is off or something else is running', async () => {
    const w = windowWith({ ready: true })
    let atRest = false
    mgr.useUpdateAtRest(() => atRest)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const call = mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    await vi.waitFor(() => expect(card(session.id)?.detail).toEqual({ kind: 'other', raw: CENTRALU_APPLY_QUESTION, about: CENTRALU_APPLY }))
    expect(w.relaunches).toEqual([])
    mgr.respondApproval(session.id, card(session.id)!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    // At rest from now on: the same session is not asked
    atRest = true
    expect((await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })).isError).toBeUndefined()
    expect(w.relaunches).toHaveLength(1)
  })

  it('at rest, safe is still refused and an agent an app started still cannot apply', async () => {
    const w = windowWith({ ready: true })
    mgr.useUpdateAtRest(() => true)
    const project = await addProject()
    const safe = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'safe' })
    expect(await mgr.runOrchestratorTool(safe.id, 'update_centralu', { action: 'apply' })).toMatchObject({ isError: true, text: expect.stringContaining('preset is safe') })
    const agent = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'auto', appId: 'agent', appAgent: {} })
    await expect(mgr.runOrchestratorTool(agent.id, 'update_centralu', { action: 'apply' })).rejects.toThrow()
    expect(w.asked).toEqual([])
  })

  it('at rest, nothing installed still says so and relaunches nothing', async () => {
    const w = windowWith({ ready: false, reason: 'No update is installed to apply.' })
    mgr.useUpdateAtRest(() => true)
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    expect(await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })).toMatchObject({ isError: true, text: expect.stringContaining('No update is installed to apply.') })
    expect(w.relaunches).toEqual([])
  })

  it('safe: refused without asking the windows or the person', async () => {
    const w = windowWith({ ready: true })
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'safe' })
    const out = await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('preset is safe') })
    expect(w.asked).toEqual([])
    expect(card(session.id)).toBeUndefined()
  })

  it('an agent an app started cannot apply, whatever its preset', async () => {
    const w = windowWith({ ready: true })
    const project = await addProject()
    const agent = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'auto', appId: 'agent', appAgent: {} })
    await expect(mgr.runOrchestratorTool(agent.id, 'update_centralu', { action: 'apply' })).rejects.toThrow()
    expect(w.asked).toEqual([])
  })

  it('nothing installed: says so, and never raises a card', async () => {
    const w = windowWith({ ready: false, reason: 'No update is installed to apply.' })
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const out = await mgr.runOrchestratorTool(session.id, 'update_centralu', { action: 'apply' })
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('No update is installed to apply.') })
    expect(card(session.id)).toBeUndefined()
    expect(w.relaunches).toEqual([])
  })
})
