import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { createRpcHandler } from '../rpc.js'
import { Store } from '../dev-services/store.js'
import { FakeAdapter } from './manager.test-helpers.js'
import { SessionManager } from './manager.js'
import { adoptOpenedSettings } from './opened-settings.js'

/**
 * The record follows what the tool's conversation runs (#1369): an imported Codex thread keeps the model it was started
 * with, and the session used to show the model it was recorded with instead.
 */
const handleOf = (opened: { model: string | null; effort: string | null } | null) => ({ takeOpenedSettings: () => opened })

describe('adoptOpenedSettings', () => {
  it('leaves a model and an effort on the default alone unless the conversation was taken over from elsewhere', () => {
    const started = { model: null as string | null, effort: null as string | null }
    expect(adoptOpenedSettings(handleOf({ model: 'gpt-5.6-luna', effort: 'medium' }), started, { ...started }, false)).toBe(false)
    expect(started).toEqual({ model: null, effort: null })

    const imported = { model: null as string | null, effort: null as string | null }
    expect(adoptOpenedSettings(handleOf({ model: 'gpt-5.5', effort: 'medium' }), imported, { ...imported }, true)).toBe(true)
    expect(imported).toEqual({ model: 'gpt-5.5', effort: 'medium' })
  })

  it('takes what the conversation runs into the record and into what the process runs', () => {
    const record = { model: 'gpt-5.6-terra', effort: null as string | null }
    const launched = { ...record }
    expect(adoptOpenedSettings(handleOf({ model: 'gpt-5.5', effort: 'medium' }), record, launched, true)).toBe(true)
    expect(record).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    expect(launched).toEqual({ model: 'gpt-5.5', effort: 'medium' })
  })

  it("keeps a value the person chose while the process came up, and counts what runs as launched so the restart applies theirs", () => {
    const launched = { model: 'gpt-5.6-terra', effort: 'high' as string | null }
    const record = { model: 'gpt-5.4', effort: 'high' as string | null }
    expect(adoptOpenedSettings(handleOf({ model: 'gpt-5.5', effort: 'high' }), record, launched, false)).toBe(false)
    expect(record.model).toBe('gpt-5.4')
    expect(launched.model).toBe('gpt-5.5')
  })

  it('does nothing for a conversation that runs what it was asked, or a tool that does not say', () => {
    const record = { model: 'a', effort: null as string | null }
    expect(adoptOpenedSettings(handleOf(null), record, { ...record }, true)).toBe(false)
    expect(adoptOpenedSettings({}, record, { ...record }, true)).toBe(false)
    expect(adoptOpenedSettings(handleOf({ model: 'a', effort: null }), record, { ...record }, true)).toBe(false)
  })
})

/** A tool that reports the model its conversation turned out to run */
class OpeningAdapter extends FakeAdapter {
  opened: { model: string | null; effort: string | null } | null = { model: 'gpt-5.5', effort: 'medium' }
  override async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const handle = await super.createSession(opts, emit)
    ;(handle as SessionHandle).takeOpenedSettings = () => {
      const o = this.opened
      this.opened = null
      return o
    }
    return handle
  }
}

describe('a session whose conversation runs another model than the record', () => {
  let adapter: OpeningAdapter
  let mgr: SessionManager
  let events: NormalizedEvent[]
  let rpc: ReturnType<typeof createRpcHandler>
  beforeEach(() => {
    adapter = new OpeningAdapter()
    events = []
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    mgr = new SessionManager(new Store(), adapters, (e) => events.push(e))
    rpc = createRpcHandler(mgr, adapters)
  })
  const drifted = (id: string) => (mgr as unknown as { restartPolicy: { settingsDrifted(id: string): boolean } }).restartPolicy.settingsDrifted(id)
  const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string }>

  it('an imported one is recorded with the model that runs, saved and announced', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', model: 'gpt-5.6-terra', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string; model: string | null; effort: string | null }
    expect(s).toMatchObject({ model: 'gpt-5.5', effort: 'medium' })
    const listed = mgr.listSessions().find((x) => x.id === s.id)
    expect(listed).toMatchObject({ model: 'gpt-5.5', effort: 'medium' })
    // What the process runs is what the record says: nothing is waiting for a restart
    expect(drifted(s.id)).toBe(false)
  })

  it('a session started here on the default stays on it: the answer is a concrete value from Codex, not a choice', async () => {
    const p = await addProject()
    adapter.opened = null
    Object.assign(adapter.capabilities, { backgroundTasks: true })
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    expect(await mgr.sleepSession(s.id)).toBe(true)
    adapter.opened = { model: 'gpt-5.6-luna', effort: 'medium' }
    events.length = 0

    await mgr.resumeSession(s.id)

    expect(mgr.listSessions().find((x) => x.id === s.id)).toMatchObject({ model: null, effort: null })
    expect(events.filter((e) => e.type === 'settings_changed')).toEqual([])
  })

  it('a woken one is recorded with it too, and the restart check compares with what runs', async () => {
    const p = await addProject()
    adapter.opened = null
    // A tool that reports its background work can be put to sleep
    Object.assign(adapter.capabilities, { backgroundTasks: true })
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', model: 'gpt-5.6-terra' })) as { id: string }
    expect(await mgr.sleepSession(s.id)).toBe(true)
    adapter.opened = { model: 'gpt-5.5', effort: null }
    events.length = 0
    // What the process is registered as running with, as it is at that moment: the record is registered by reference
    const running = (mgr as unknown as { running: Map<string, { model: string | null }> }).running
    const registered: (string | null)[] = []
    const set = running.set.bind(running)
    running.set = (id, launched) => (registered.push(launched.model), set(id, launched))

    await mgr.resumeSession(s.id)

    expect(registered).toEqual(['gpt-5.5'])

    expect(mgr.listSessions().find((x) => x.id === s.id)?.model).toBe('gpt-5.5')
    expect(events).toContainEqual(expect.objectContaining({ type: 'settings_changed', sessionId: s.id, model: 'gpt-5.5', by: 'tool' }))
    expect(drifted(s.id)).toBe(false)
  })
})
