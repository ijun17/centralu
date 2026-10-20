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

  it("does not shrink the window with what Claude reads back under the setting: it reports the setting, not the model's window", () => {
    const w = new ModelWindows(settings())
    w.note(m('a', 'sonnet', 'claude'), 200_000)
    // Started at 60%, the CLI reads back its autoCompactWindow
    w.started('a', 120_000)
    w.note(m('a', 'sonnet', 'claude'), 133_000)
    expect(w.of(m('a', 'sonnet', 'claude'))).toBe(200_000)
    // A larger reading is a real change of the model's window
    w.note(m('a', 'sonnet', 'claude'), 1_000_000)
    expect(w.of(m('a', 'sonnet', 'claude'))).toBe(1_000_000)
    // A process started without the setting reports the window itself
    w.started('b', null)
    w.note(m('b', 'sonnet', 'claude'), 200_000)
    expect(w.of(m('b', 'sonnet', 'claude'))).toBe(200_000)
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
