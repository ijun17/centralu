import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { HistoryMessage } from '../adapters/contract.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A queued request whose turn never starts (#839, item 2). A request queued for a busy session (#677) stays
 * `delivering` until the session's turn starts (#684 review). A tool that refuses the input outright (an error, a usage
 * limit) never starts one: the request stayed `delivering`, the session counted as busy for every requester after it,
 * and nothing queued behind it was ever delivered.
 */
describe('a queued request whose turn never starts (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const session = async () => (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
  /** B with a child A it started, which the person is now using for a turn of their own */
  const busyChild = async () => {
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = await session()
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const a = started.sessionId
    handleOf(a).externalId = 'ext-a'
    handleOf(a).answer('first job done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    await w.mgr.send(a, "the person's own work")
    return { a, b }
  }
  /** The reports of A's work that B was given */
  const told = (b: string, a: string) =>
    w.store.loadMessages(b, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work') && t.includes(a))
  /** The tool answers an input that names `marker` with `refusal` instead of starting a turn */
  const refuses = (a: string, marker: string, refusal: NormalizedEvent) => {
    const h = handleOf(a)
    const send = h.send.bind(h)
    h.send = (text: string) => {
      if (!text.includes(marker)) return send(text)
      h.sent.push(text)
      h.event(refusal)
    }
  }

  it.each<[string, (a: string) => NormalizedEvent]>([
    ['an error', (a) => ({ type: 'error', sessionId: a, error: { code: 'internal', message: 'the API refused the request', retryable: false } })],
    ['a usage limit', (a) => ({ type: 'limit_reached', sessionId: a })],
  ])('after %s the request is done with, and the next one in the queue goes in', async (_, refusal) => {
    const { a, b } = await busyChild()
    const c = await session()
    refuses(a, 'first in line', refusal(a))
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'first in line', ifBusy: 'queue' })).toMatchObject({ state: 'queued', position: 1 })
    expect(await w.mgr.agentSession(c, { sessionId: a, action: 'send', text: 'second in line', ifBusy: 'queue' })).toMatchObject({ state: 'queued', position: 2 })
    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.some((t) => t.includes('first in line')))
    // An error is a rest of its own: the person's Continue, or the next request, starts the next turn
    await w.until(() => handleOf(a).sent.some((t) => t.includes('second in line')))
    expect(w.store.listQueuedRequests()).toEqual([])
  })

  it("an ask queued into another project's busy session is reported as failed once, and the person's next turn is not", async () => {
    const t = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    handleOf(t).externalId = 'ext-t'
    await w.mgr.send(t, "the person's own work")
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    refuses(t, 'export the sprites', { type: 'error', sessionId: t, error: { code: 'internal', message: 'the API refused the request', retryable: false } })
    expect(await w.mgr.askProject(s, { project: w.target.name, session: t, task: 'export the sprites', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    handleOf(t).answer("the person's answer")
    await w.until(() => told(s, t).length === 1)
    expect(told(s, t)[0]).toContain('The assigned work failed')
    await w.mgr.send(t, "the person's next thing")
    handleOf(t).answer("the person's next answer")
    await new Promise((r) => setImmediate(r))
    expect(told(s, t)).toHaveLength(1)
  })

  it("a queued ask that could not be delivered is said once, and the person's next turn is not reported as it", async () => {
    const t = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    handleOf(t).externalId = 'ext-t'
    await w.mgr.send(t, "the person's own work")
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    expect(await w.mgr.askProject(s, { project: w.target.name, session: t, task: 'export the sprites', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    // The process goes down with the person's turn, and the tool cannot start again for the delivery
    const adapter = w.adapters.get('claude')!
    const start = adapter.createSession.bind(adapter)
    adapter.createSession = async () => { throw new Error('the tool would not start') }
    handleOf(t).event({ type: 'error', sessionId: t, error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    const notDelivered = () => w.store.loadMessages(s, 50).filter((m) => JSON.stringify(m.payload).includes('was not delivered'))
    await w.until(() => notDelivered().length === 1)
    adapter.createSession = start
    await w.mgr.send(t, "the person's next thing")
    handleOf(t).answer("the person's next answer")
    await new Promise((r) => setImmediate(r))
    expect(told(s, t)).toEqual([])
  })

  it('a refused request does not leave the session busy for the next requester', async () => {
    const { a, b } = await busyChild()
    // The first job's report is already there
    const before = told(b, a).length
    refuses(a, 'add the index', { type: 'error', sessionId: a, error: { code: 'internal', message: 'the API refused the request', retryable: false } })
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'add the index', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.some((t) => t.includes('add the index')))
    await w.until(() => w.store.listQueuedRequests().length === 0)
    // Its requester is told once that the work failed, and only of that work
    await w.until(() => told(b, a).length === before + 1)
    expect(told(b, a).at(-1)).toContain('The assigned work failed')
    // Not busy: the work goes in as the caller's own turn, and the call waits on it
    const r = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'try again' })
    await w.until(() => !!handleOf(a).sent.at(-1)?.includes('try again'))
    handleOf(a).answer('done this time')
    expect(await r).toMatchObject({ ok: true, state: 'done', answer: 'done this time' })
    // The person's later turn there is not reported as that work either
    await w.mgr.send(a, "the person's next thing")
    handleOf(a).answer("the person's next answer")
    await new Promise((r) => setImmediate(r))
    expect(told(b, a)).toHaveLength(before + 1)
  })

  /**
   * The queued request goes in through a wake (#839 review): the person's turn ends with its process, so the drain wakes
   * the session, and the wake's catch-up is held until the test lets it go. Returns the release.
   */
  const queuedThroughWake = async () => {
    const { a, b } = await busyChild()
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'add the index', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    let release!: (h: HistoryMessage[]) => void
    let reading = false
    Object.assign(w.adapters.get('claude')!, { readExternalHistory: () => ((reading = true), new Promise<HistoryMessage[]>((r) => (release = r))) })
    const before = told(b, a).length
    handleOf(a).event({ type: 'error', sessionId: a, error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    await w.until(() => reading)
    return { a, b, before, release: () => release([]) }
  }

  it('a usage limit the tool reports during the wake, before the input goes in, does not end the request', async () => {
    const { a, b, before, release } = await queuedThroughWake()
    // Codex reports an account-wide limit change at any moment
    handleOf(a).event({ type: 'limit_reached', sessionId: a })
    expect(w.store.listQueuedRequests()).toHaveLength(1)
    release()
    await w.until(() => handleOf(a).sent.some((t) => t.includes('add the index')))
    expect(told(b, a)).toHaveLength(before)
    // The turn it started is the one reported
    handleOf(a).answer('index added')
    await w.until(() => told(b, a).length === before + 1)
    expect(told(b, a).at(-1)).toContain('The assigned work finished')
  })

  it('a crash during the wake is said once, as not delivered', async () => {
    const { a, b, before, release } = await queuedThroughWake()
    handleOf(a).event({ type: 'error', sessionId: a, error: { code: 'adapter_crashed', message: 'the process exited again', retryable: true } })
    release()
    const notDelivered = () => w.store.loadMessages(b, 50).filter((m) => JSON.stringify(m.payload).includes('was not delivered'))
    await w.until(() => notDelivered().length === 1)
    await new Promise((r) => setImmediate(r))
    expect(told(b, a)).toHaveLength(before)
    expect(notDelivered()).toHaveLength(1)
  })

})
