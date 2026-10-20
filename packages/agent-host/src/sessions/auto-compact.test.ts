import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUTO_COMPACT, autoCompactOf, readAutoCompact } from '@cc/protocol'
import type { SessionHandle } from '../adapters/contract.js'
import { FakeHandle, managerWorld } from './manager.test-helpers.js'
import { ModelWindows, autoCompactTokens } from './auto-compact.js'

/**
 * Where agents compact by themselves is Centralu's setting (#1376): a share of the model's window, 60% unless changed, for
 * Claude and Codex alike, and nothing at all when the person turns Centralu's control off.
 */
const on = DEFAULT_AUTO_COMPACT

describe('autoCompactTokens', () => {
  it('is 60% of the window by default: 120k of a 200k model, 600k of a 1M one', () => {
    expect(autoCompactTokens(on, 200_000)).toBe(120_000)
    expect(autoCompactTokens(on, 1_000_000)).toBe(600_000)
    expect(autoCompactTokens({ controlled: true, share: 0.2 }, 128_000)).toBe(25_600)
    expect(autoCompactTokens({ controlled: true, share: 0.6 }, 258_400)).toBe(155_040)
    expect(autoCompactTokens({ controlled: true, share: 0.2 }, 1)).toBe(1)
  })

  it("passes nothing when Centralu does not control it, or the model's window is not known", () => {
    expect(autoCompactTokens({ controlled: false, share: 0.6 }, 200_000)).toBeNull()
    expect(autoCompactTokens(on, null)).toBeNull()
    expect(autoCompactTokens(on, 0)).toBeNull()
  })
})

describe('the setting as stored', () => {
  it('reads as on at 60% for a record from before it, and field by field otherwise', () => {
    expect(autoCompactOf({})).toEqual({ controlled: true, share: 0.6 })
    expect(readAutoCompact({ controlled: false })).toEqual({ controlled: false, share: 0.6 })
    expect(readAutoCompact({ share: 0.75 })).toEqual({ controlled: true, share: 0.75 })
    // A value from another build or a hand edit lands inside the range, or is no choice at all
    expect(readAutoCompact({ share: 5 }).share).toBe(0.95)
    expect(readAutoCompact({ share: 0.01 }).share).toBe(0.2)
    expect(readAutoCompact({ controlled: 'no', share: 'half' })).toEqual({ controlled: true, share: 0.6 })
    expect(readAutoCompact('x')).toEqual({ controlled: true, share: 0.6 })
  })
})

describe('ModelWindows', () => {
  const settings = () => {
    const values = new Map<string, string>()
    return { appSetting: (k: string) => values.get(k) ?? null, setAppSetting: (k: string, v: string) => void values.set(k, v) }
  }
  const m = (id: string, model: string | null, tool: 'claude' | 'codex' = 'codex', projectId: string | null = 'p1') => ({ id, tool, model, projectId })

  it("keeps a window per tool and model, across a restart of the host, and none for a model nobody has read", () => {
    const store = settings()
    new ModelWindows(store).note(m('a', 'gpt-5.6'), 258_400)
    const again = new ModelWindows(store)
    expect(again.of(m('b', 'gpt-5.6'))).toBe(258_400)
    expect(again.of(m('b', 'gpt-5.5'))).toBeNull()
    expect(again.of(m('b', 'gpt-5.6', 'claude'))).toBeNull()
  })

  it("keeps a default model's window per project: the default differs between them", () => {
    const w = new ModelWindows(settings())
    w.note(m('a', null, 'codex', 'p1'), 400_000)
    expect(w.of(m('b', null, 'codex', 'p1'))).toBe(400_000)
    expect(w.of(m('c', null, 'codex', 'p2'))).toBeNull()
  })

  it("follows a model switch: the new model has its own window, not the old one's", () => {
    const w = new ModelWindows(settings())
    w.note(m('a', 'sonnet', 'claude'), 200_000)
    expect(w.of(m('a', 'sonnet[1m]', 'claude'))).toBeNull()
  })

  it("a reading from a process started with the setting that is below its ceiling is the model's real window, even when a larger one was known", () => {
    const w = new ModelWindows(settings())
    // 1M learnt under the alias, then the alias moved to a 200k model: the CLI reports 200,000 under a ceiling of 633,000
    w.note(m('a', 'haiku', 'claude'), 1_000_000, 'claude-haiku-5-5')
    w.started('a', 633_000)
    w.note(m('a', 'haiku', 'claude'), 200_000, 'claude-haiku-4-5')
    expect(w.of(m('a', 'haiku', 'claude'))).toBe(200_000)
  })

  it('a reading at the ceiling is only "at least": the record stands for the same model, and is dropped for another so it can rise', () => {
    const w = new ModelWindows(settings())
    w.note(m('a', 'haiku', 'claude'), 200_000, 'claude-haiku-4-5')
    // The same model reports the ceiling it was given: the record is not lowered
    w.started('a', 153_000)
    w.note(m('a', 'haiku', 'claude'), 153_000, 'claude-haiku-4-5')
    expect(w.of(m('a', 'haiku', 'claude'))).toBe(200_000)
    // The alias now means a 1M model: a 200k record would make it compact at 10% for ever, so it goes and is learnt again
    w.note(m('a', 'haiku', 'claude'), 153_000, 'claude-haiku-5-5')
    expect(w.of(m('a', 'haiku', 'claude'))).toBeNull()
    // The next start passes nothing; its reading is the real window
    w.started('a', null)
    w.note(m('a', 'haiku', 'claude'), 1_000_000, 'claude-haiku-5-5')
    expect(w.of(m('a', 'haiku', 'claude'))).toBe(1_000_000)
  })

  it("a tool that reports the model's own window (no ceiling) always records what it reads", () => {
    const w = new ModelWindows(settings())
    w.note(m('a', 'gpt-5.6'), 1_000_000)
    w.note(m('a', 'gpt-5.6'), 272_000)
    expect(w.of(m('a', 'gpt-5.6'))).toBe(272_000)
  })

  it('keeps the model beside the window across a restart of the host', () => {
    const store = settings()
    new ModelWindows(store).note(m('a', 'haiku', 'claude'), 200_000, 'claude-haiku-4-5')
    const again = new ModelWindows(store)
    again.started('b', 153_000)
    again.note(m('b', 'haiku', 'claude'), 153_000, 'claude-haiku-5-5')
    expect(again.of(m('b', 'haiku', 'claude'))).toBeNull()
  })
})

describe('what a session is launched with', () => {
  let world: ReturnType<typeof managerWorld>
  beforeEach(() => {
    world = managerWorld()
    Object.assign(world.codexAdapter.capabilities, { backgroundTasks: true })
  })
  const create = async () => {
    const p = (await world.rpc('projects.add', { path: tmpdir() })) as { id: string }
    return (await world.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'codex', model: 'gpt-5.6' })) as { id: string }
  }
  const handle = (id: string) => world.codexAdapter.handleOf(id) as FakeHandle & SessionHandle

  it('passes nothing at the first start of a model nobody has read a window from, and the value at the next start', async () => {
    const s = await create()
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBeUndefined()

    handle(s.id).emitContext(10_000, 258_400)
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(155_040)
  })

  it("a Codex session reports the model's own window: a smaller one replaces the known window, and the next start passes the share of it", async () => {
    const s = await create()
    handle(s.id).emitContext(10_000, 1_000_000)
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(600_000)

    // Started with the setting, the thread reports its real, smaller window (the default model changed, the provider shrank it)
    handle(s.id).emitContext(10_000, 272_000)
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(163_200)
  })

  it("a tool whose window follows the compaction point (Claude's): a real smaller window is learnt, and the share applies to it", async () => {
    Object.assign(world.codexAdapter, { windowCeilingFor: (tokens: number) => tokens + 33_000 })
    const s = await create()
    handle(s.id).emitContext(10_000, 1_000_000, 'big')
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(600_000)
    // The name now means a 200k model: under the ceiling of 633,000 it reports 200,000, which is real
    handle(s.id).emitContext(10_000, 200_000, 'small')
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(120_000)
  })

  it('what the session menu is told is what the next start passes (agents.autoCompact)', async () => {
    const s = await create()
    // Nothing read yet: the menu says nothing is passed, as the start did
    expect(await world.rpc('agents.autoCompact', { sessionId: s.id })).toEqual({ controlled: true, share: 0.6, tokens: null })
    handle(s.id).emitContext(10_000, 200_000)
    expect(await world.rpc('agents.autoCompact', { sessionId: s.id })).toEqual({ controlled: true, share: 0.6, tokens: 120_000 })
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(120_000)

    // A model switch: the old model's window is not the new one's, and the menu says so before the start does
    await world.rpc('agents.updateSettings', { sessionId: s.id, model: 'gpt-5.7' })
    expect(await world.rpc('agents.autoCompact', { sessionId: s.id })).toEqual({ controlled: true, share: 0.6, tokens: null })

    // Turned off: the menu says the control is off
    await world.rpc('prefs.set', { patch: { autoCompact: { controlled: false } } })
    expect(await world.rpc('agents.autoCompact', { sessionId: s.id })).toMatchObject({ controlled: false, tokens: null })
  })

  it('a new session of a model another session has read the window of gets the value at once', async () => {
    const first = await create()
    handle(first.id).emitContext(10_000, 258_400)
    const second = await create()
    expect(second.id).not.toBe(first.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(155_040)
  })

  it("follows the setting at the next start: the share changed, then Centralu's control turned off", async () => {
    const s = await create()
    handle(s.id).emitContext(10_000, 200_000)

    await world.rpc('prefs.set', { patch: { autoCompact: { share: 0.5 } } })
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBe(100_000)

    await world.rpc('prefs.set', { patch: { autoCompact: { controlled: false } } })
    expect(await world.mgr.sleepSession(s.id)).toBe(true)
    await world.mgr.resumeSession(s.id)
    expect(world.codexAdapter.lastOpts?.autoCompactTokens).toBeUndefined()
    // The share stays for when it is turned back on
    expect(((await world.rpc('prefs.get', {})) as { autoCompact: unknown }).autoCompact).toEqual({ controlled: false, share: 0.5 })
  })
})
