import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { ASK_WAIT_MS } from './ask-project.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

describe("auto observes another caller's delegation without consuming it", () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })
  const session = async (permissionPreset: PermissionPreset, project = w.caller) =>
    (
      await w.mgr.createSession({
        projectId: project.id,
        cwd: project.path,
        tool: 'claude',
        permissionPreset,
      })
    ).id
  const handle = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const reports = (id: string, child: string) =>
    handle(id).sent.filter((text) => text.includes(`sourceSessionId: ${child}`))
  const start = async () => {
    const owner = await session('normal')
    const observer = await session('auto')
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const result = await w.mgr.startAgent(owner, { task: 'owner work', wait: false })
    if (!result.ok) throw new Error(result.error)
    return { owner, observer, child: result.sessionId }
  }
  const ownerReport = async (owner: string, child: string) => {
    await w.until(() => reports(owner, child).length === 1)
    expect(reports(owner, child)).toHaveLength(1)
  }

  it.each(['status', 'send', 'wait'] as const)(
    "%s leaves the normal owner's report and answer available once, and grants neither caller files",
    async (action) => {
      const { owner, observer, child } = await start()
      const path = join(w.caller.path, 'answer.txt')
      writeFileSync(path, 'answer')
      const observing = w.mgr.agentSession(observer, { sessionId: child, action, text: 'observer note' })
      if (action !== 'wait')
        expect(await observing).toMatchObject({ ok: true, state: 'working', reported: false })
      handle(child).answer(`Read ${path}`)
      if (action === 'wait')
        expect(await observing).toMatchObject({ ok: true, state: 'done', readable: [], outside: [] })
      await ownerReport(owner, child)
      expect(handle(observer).sent).toEqual([])
      expect(handle(owner).opts.mayRead?.(path)).toBe(false)
      expect(handle(observer).opts.mayRead?.(path)).toBe(false)
      expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
        ok: true,
        state: 'done',
        answer: `Read ${path}`,
      })
      expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
        ok: true,
        state: 'at_rest',
      })
      expect(reports(owner, child)).toHaveLength(1)
    },
  )

  it("an observer's bound never arms its own report or changes the owner's report", async () => {
    const { owner, observer, child } = await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const waiting = w.mgr.agentSession(observer, { sessionId: child, action: 'wait' })
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await waiting).toMatchObject({ ok: true, state: 'working', reported: false })
    vi.useRealTimers()
    handle(child).answer('owner answer')
    await ownerReport(owner, child)
    expect(handle(observer).sent).toEqual([])
    expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
      ok: true,
      state: 'done',
      answer: 'owner answer',
    })
  })

  it.each(['signal', 'stop caller'] as const)(
    "cancelling via %s leaves the observed child running and the owner's report intact",
    async (cancel) => {
      const { owner, observer, child } = await start()
      const controller = new AbortController()
      const waiting = w.mgr.agentSession(observer, { sessionId: child, action: 'wait' }, controller.signal)
      if (cancel === 'stop caller') w.mgr.interrupt(observer)
      controller.abort()
      expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining('left running') })
      expect(handle(child).interrupted).toBe(0)
      handle(child).answer('still finished')
      await ownerReport(owner, child)
      expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
        ok: true,
        state: 'done',
        answer: 'still finished',
      })
    },
  )

  it("auto stop preserves the owner's error report and error answer", async () => {
    const { owner, observer, child } = await start()
    expect(await w.mgr.agentSession(observer, { sessionId: child, action: 'stop' })).toMatchObject({
      ok: true,
      state: 'stopped',
    })
    await ownerReport(owner, child)
    const report = w.store
      .loadMessages(owner, 20)
      .find((m) => JSON.stringify(m.payload).includes('assigned work failed'))
    expect(report).toBeDefined()
    expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('stopped'),
    })
    expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
      ok: true,
      state: 'at_rest',
    })
    expect(reports(owner, child)).toHaveLength(1)
    expect(handle(observer).sent).toEqual([])
  })

  it('an observer cannot re-arm a report while the owner is already waiting', async () => {
    const { owner, observer, child } = await start()
    const ownWait = w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const observation = w.mgr.agentSession(observer, { sessionId: child, action: 'wait' })
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await observation).toMatchObject({ ok: true, state: 'working', reported: false })
    vi.useRealTimers()
    handle(child).answer('only an answer')
    expect(await ownWait).toMatchObject({ ok: true, state: 'done', answer: 'only an answer' })
    // The owner consumed the answer through its active wait, so there is no background receipt.
    await w.mgr.agentSession(owner, { sessionId: child, action: 'status' })
    expect(reports(owner, child)).toEqual([])
  })

  it("an observation does not turn the normal owner's background child into an owned wait", async () => {
    const { owner, observer, child } = await start()
    const observation = w.mgr.agentSession(observer, { sessionId: child, action: 'wait' })
    w.mgr.interrupt(owner)
    expect(handle(child).interrupted).toBe(0)
    handle(child).answer('background child finished')
    expect(await observation).toMatchObject({ ok: true, state: 'done' })
    await ownerReport(owner, child)
    expect(await w.mgr.agentSession(owner, { sessionId: child, action: 'wait' })).toMatchObject({
      ok: true,
      state: 'done',
      answer: 'background child finished',
    })
  })

  it.each(['wait', 'stop'] as const)(
    '%s preserves an ask_project delegation owned by a session in another project',
    async (action) => {
      w.mgr.setProjectTrusted(w.target.id, true)
      const owner = await session('normal', w.target)
      const observer = await session('auto')
      w.store.setProjectConsent(w.target.id, w.caller.id, 'delegate')
      const child = await session('normal')
      const asking = w.mgr.askProject(owner, { project: w.caller.id, session: child, task: 'other project work' })
      await w.until(() => !!handle(child)?.sent.length)
      const observed = w.mgr.agentSession(observer, { sessionId: child, action })
      if (action === 'wait') handle(child).answer('cross-project answer')
      expect(await observed).toMatchObject({ ok: true, state: action === 'wait' ? 'done' : 'stopped' })
      expect(await asking).toMatchObject(
        action === 'wait'
          ? { ok: true, state: 'done', answer: 'cross-project answer' }
          : { ok: false, error: expect.stringContaining('stopped') },
      )
      expect(handle(observer).sent).toEqual([])
    },
  )

  it.each(['wait', 'stop'] as const)(
    '%s leaves a bounded ask_project result under its original key',
    async (action) => {
      w.mgr.setProjectTrusted(w.target.id, true)
      const owner = await session('normal', w.target)
      const observer = await session('auto')
      w.store.setProjectConsent(w.target.id, w.caller.id, 'delegate')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const child = await session('normal')
      const asking = w.mgr.askProject(owner, { project: w.caller.id, session: child, task: 'other project work' })
      for (let n = 0; n < 50 && !handle(child)?.sent.length; n++)
        await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
      expect(await asking).toMatchObject({ ok: true, state: 'working' })
      vi.useRealTimers()
      const observation = w.mgr.agentSession(observer, { sessionId: child, action })
      if (action === 'wait') handle(child).answer('retained answer')
      expect(await observation).toMatchObject({ ok: true, state: action === 'wait' ? 'done' : 'stopped' })
      expect(await w.mgr.askProject(owner, { project: w.caller.id })).toMatchObject(
        action === 'wait'
          ? { ok: true, state: 'done', answer: 'retained answer' }
          : { ok: false, error: expect.stringContaining('stopped') },
      )
      expect(await w.mgr.askProject(owner, { project: w.caller.id })).toMatchObject({
        ok: false,
        error: expect.stringContaining('Name a session'),
      })
      expect(handle(observer).sent).toEqual([])
    },
  )

  it.each(['safe', 'normal', 'auto'] as const)(
    '%s refuses self wait/stop/delete/send before changing the session',
    async (preset) => {
      const id = await session(preset)
      for (const action of ['wait', 'stop', 'delete', 'send'] as const) {
        expect(await w.mgr.agentSession(id, { sessionId: id, action, text: 'self work' })).toMatchObject({
          ok: false,
          error: expect.stringContaining('own calling session'),
        })
      }
      expect(handle(id).sent).toEqual([])
      expect(handle(id).interrupted).toBe(0)
      expect(w.mgr.listSessions().some((s) => s.id === id)).toBe(true)
    },
  )
})
