import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASK_WAIT_MS } from './ask-project.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

describe("observing a person's turn never owns it", () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    for (const adapter of w.adapters.values())
      Object.assign(adapter.capabilities, { backgroundTasks: true, sleep: true })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })
  const handle = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const setup = async () => {
    const observer = await w.mgr.createSession({
      projectId: w.caller.id,
      cwd: w.caller.path,
      tool: 'claude',
      permissionPreset: 'auto',
    })
    const target = await w.mgr.createSession({
      projectId: w.caller.id,
      cwd: w.caller.path,
      tool: 'claude',
      permissionPreset: 'normal',
    })
    await w.mgr.send(target.id, 'the person starts work')
    return { observer: observer.id, target: target.id }
  }

  it.each(['status', 'wait'] as const)(
    "%s followed by Stop on the caller leaves the person's turn running and permits caller sleep",
    async (action) => {
      const { observer, target } = await setup()
      const result = w.mgr.agentSession(observer, { sessionId: target, action })
      if (action === 'status')
        expect(await result).toMatchObject({ ok: true, state: 'working', reported: false })
      w.mgr.interrupt(observer)
      expect(handle(target).interrupted).toBe(0)
      expect(w.mgr.listSessions().find((s) => s.id === target)?.state).toBe('working')
      expect(w.mgr.waitsOn(observer)).toEqual([])
      expect(await w.mgr.sleepSession(observer)).toBe(true)
      handle(target).answer("the person's answer")
      if (action === 'wait')
        expect(await result).toMatchObject({
          ok: true,
          state: 'done',
          answer: "the person's answer",
          readable: [],
        })
    },
  )

  it("cancelling a passive wait leaves the person's turn running and removes any caller sleep dependency", async () => {
    const { observer, target } = await setup()
    const controller = new AbortController()
    const result = w.mgr.agentSession(observer, { sessionId: target, action: 'wait' }, controller.signal)
    controller.abort()
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('left running') })
    expect(handle(target).interrupted).toBe(0)
    expect(w.mgr.waitsOn(observer)).toEqual([])
    expect(await w.mgr.sleepSession(observer)).toBe(true)
    handle(target).answer('still finished')
    expect(w.mgr.listSessions().find((s) => s.id === target)?.state).toBe('waiting_input')
  })

  it('a bounded passive wait promises no report and leaves the caller free to sleep', async () => {
    const { observer, target } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = w.mgr.agentSession(observer, { sessionId: target, action: 'wait' })
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await result).toMatchObject({ ok: true, state: 'working', reported: false })
    vi.useRealTimers()
    expect(w.mgr.waitsOn(observer)).toEqual([])
    expect(await w.mgr.sleepSession(observer)).toBe(true)
    expect(handle(target).interrupted).toBe(0)
    handle(target).answer('later answer')
    expect(handle(observer).sent).toEqual([])
  })

  it('two independent readers can observe the same turn; cancelling one does not end the other', async () => {
    const { observer, target } = await setup()
    const other = await w.mgr.createSession({
      projectId: w.caller.id,
      cwd: w.caller.path,
      tool: 'claude',
      permissionPreset: 'auto',
    })
    const controller = new AbortController()
    const cancelled = w.mgr.agentSession(observer, { sessionId: target, action: 'wait' }, controller.signal)
    const retained = w.mgr.agentSession(other.id, { sessionId: target, action: 'wait' })
    controller.abort()
    expect((await cancelled).ok).toBe(false)
    expect(handle(target).interrupted).toBe(0)
    handle(target).answer("both readers' answer")
    expect(await retained).toMatchObject({ ok: true, state: 'done', answer: "both readers' answer" })
    expect(w.mgr.waitsOn(other.id)).toEqual([])
  })

  it('captures the observed answer before a subscriber starts an unrelated turn', async () => {
    const { observer, target } = await setup()
    const waiting = w.mgr.agentSession(observer, { sessionId: target, action: 'wait' })
    handle(target).answer('observed answer')
    handle(target).send("another person's message")
    handle(target).answer('unrelated answer')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'observed answer' })
  })

  it("deleting the observed session ends its reader without stopping the reader's session", async () => {
    const { observer, target } = await setup()
    const waiting = w.mgr.agentSession(observer, { sessionId: target, action: 'wait' })
    await w.mgr.trashSession(target)
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining('deleted') })
    expect(handle(observer).interrupted).toBe(0)
    expect(w.mgr.waitsOn(observer)).toEqual([])
  })
})
