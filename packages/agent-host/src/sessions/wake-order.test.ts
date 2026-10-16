import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryMessage } from '../adapters/contract.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A send while the session wakes (#839, item 5). The new process is registered before the wake reads what the
 * conversation did outside (the catch-up, up to 10 s), and the message that woke the session goes in only after that.
 * A second send in that window found a process and went straight in: it overtook the message that woke the session.
 */
describe('a send while the session wakes (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  /** A session whose process went away with a conversation to wake, and a catch-up the test lets go of */
  const asleep = async () => {
    const t = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    handleOf(t).externalId = 'ext-t'
    handleOf(t).event({ type: 'message_delta', sessionId: t, role: 'assistant', text: 'Ready.' })
    handleOf(t).event({ type: 'error', sessionId: t, error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    expect(w.mgr.listSessions().find((s) => s.id === t)?.live).toBe(false)
    const held = { reading: false, release: (_: HistoryMessage[]) => {} }
    Object.assign(w.adapters.get('claude')!, { readExternalHistory: () => ((held.reading = true), new Promise<HistoryMessage[]>((r) => (held.release = r))) })
    return { t, held }
  }

  it('a catch-up past its bound says what it added when it lands', async () => {
    const { t, held } = await asleep()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // The screen wakes it with nothing to send
    const waking = w.mgr.resumeSession(t)
    for (let i = 0; i < 50 && !held.reading; i++) await vi.advanceTimersByTimeAsync(0)
    expect(held.reading).toBe(true)
    // The wake stops waiting for it
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waking).toMatchObject({ resumed: true })
    vi.useRealTimers()
    expect(w.events.some((e) => e.type === 'history_synced' && e.sessionId === t)).toBe(false)
    held.release([
      { role: 'assistant', text: 'Ready.' },
      { role: 'user', text: 'from the terminal' },
      { role: 'assistant', text: 'Done there.' },
    ])
    await w.until(() => w.events.some((e) => e.type === 'history_synced' && e.sessionId === t))
    expect(w.events.find((e) => e.type === 'history_synced' && e.sessionId === t)).toMatchObject({ added: 2 })
  })

  it('goes in after the message that woke it, in the order they were sent', async () => {
    const { t, held } = await asleep()
    const first = w.mgr.send(t, 'first')
    await w.until(() => held.reading)
    const second = w.mgr.send(t, 'second')
    // Everything the second send does before it waits runs within these turns of the loop
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    held.release([])
    await Promise.all([first, second])
    expect(handleOf(t).sent).toEqual(['first', 'second'])
    const said = w.store.loadMessages(t, 20).filter((m) => m.role === 'user').map((m) => (m.payload as { text: string }).text)
    expect(said).toEqual(['first', 'second'])
  })
})
