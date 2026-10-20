import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * The model a Codex session runs is the model Centralu shows for it (#1369).
 *
 * A session imported from a Codex thread started elsewhere (gpt-5.5 there) was recorded here as gpt-5.6-terra, which
 * was never sent to the thread: `thread/resume` and `turn/start` carried no model, the thread ran its own, and once the
 * provider retired that one every turn failed ("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT
 * account"). The client is swapped for a fake and the request parameters are inspected, as in verbosity.test.ts.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  /** What `thread/resume` answers: the model and effort the thread has stored (generated/v2/ThreadResumeResponse.ts) */
  resumed: { model: 'gpt-5.5', reasoningEffort: 'medium' },
  /** Holds `thread/resume`'s answer until released (a slow background resume) */
  gate: null as null | Promise<void>,
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'thread/resume') return (state.gate ?? Promise.resolve()).then(() => ({ thread: { id: 't1' }, ...state.resumed }))
      if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')
const { CodexSession } = await import('./session.js')

const paramsOf = (method: string) => state.requests.find((r) => r.method === method)?.params
const turnsStarted = () => state.requests.filter((r) => r.method === 'turn/start').map((r) => r.params)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
  state.resumed = { model: 'gpt-5.5', reasoningEffort: 'medium' }
  state.gate = null
})

async function open(over: { model?: string; effort?: string; resumeExternalId?: string }) {
  const events: NormalizedEvent[] = []
  const handle = await new CodexAdapter().createSession(
    { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', ...over },
    (e) => events.push(e),
  )
  return { handle, events }
}

describe("a resumed thread runs the session's model", () => {
  it("sends the session's model on thread/resume, and none when none is recorded", async () => {
    await open({ model: 'gpt-5.6-terra', resumeExternalId: 'ext-1' })
    expect(paramsOf('thread/resume')?.model).toBe('gpt-5.6-terra')

    state.requests.length = 0
    await open({ resumeExternalId: 'ext-1' })
    expect(paramsOf('thread/resume')).not.toHaveProperty('model')
  })

  it("sends the session's model and effort on every turn, as the thread's stored model would otherwise run", async () => {
    state.resumed = { model: 'gpt-5.6-terra', reasoningEffort: 'high' }
    const { handle } = await open({ model: 'gpt-5.6-terra', effort: 'high', resumeExternalId: 'ext-1' })
    handle.send('one')
    await tick()
    handle.send('two')
    await tick()
    expect(turnsStarted().map((p) => [p?.model, p?.effort])).toEqual([
      ['gpt-5.6-terra', 'high'],
      ['gpt-5.6-terra', 'high'],
    ])
  })

  it('sends it on a thread that was started here, too', async () => {
    const { handle } = await open({ model: 'gpt-5.6-terra' })
    expect(paramsOf('thread/start')?.model).toBe('gpt-5.6-terra')
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]?.model).toBe('gpt-5.6-terra')
  })
})

describe('what the screen shows is what runs', () => {
  const settingsEvents = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'settings_changed' || e.type === 'notice')

  it("a session with no recorded model hands the host the thread's model and effort, and its turns ask for them", async () => {
    const { handle, events } = await open({ resumeExternalId: 'ext-1' })
    // Not an event: the host cannot record one before it has registered the handle (sessions/opened-settings.ts)
    expect(settingsEvents(events)).toEqual([])
    expect(handle.takeOpenedSettings?.()).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    expect(handle.takeOpenedSettings?.()).toBeNull()
    // Nothing is asked of the thread: it runs its own, which is what the host now records
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]).not.toHaveProperty('model')
    expect(turnsStarted()[0]).not.toHaveProperty('effort')
  })

  it('a thread that answers with another model than the recorded one is shown as running it, with a warning, and is not switched back', async () => {
    state.resumed = { model: 'gpt-5.5', reasoningEffort: 'high' }
    const { handle, events } = await open({ model: 'gpt-5.6-terra', effort: 'high', resumeExternalId: 'ext-1' })
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ level: 'warning', text: expect.stringContaining('gpt-5.5, not the gpt-5.6-terra') })
    expect(handle.takeOpenedSettings?.()).toEqual({ model: 'gpt-5.5', effort: 'high' })
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]).toMatchObject({ model: 'gpt-5.5', effort: 'high' })
  })

  it("a switch made outside Centralu is not switched back by the next turn", async () => {
    const { handle, events } = await open({ model: 'gpt-5.6-terra', effort: 'high', resumeExternalId: 'ext-1' })
    state.resumed = { model: 'gpt-5.6-terra', reasoningEffort: 'high' }
    state.handlers!.onNotification({
      method: 'thread/settings/updated',
      params: { threadId: 't1', threadSettings: { model: 'gpt-5.6-luna', effort: 'high', serviceTier: null } },
    })
    expect(events.find((e) => e.type === 'settings_changed')).toMatchObject({ model: 'gpt-5.6-luna', by: 'tool' })
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]?.model).toBe('gpt-5.6-luna')
  })

  it('a resume that is still running when the host takes the settings sends them as a settings_changed once it answers', async () => {
    let release = () => {}
    state.gate = new Promise<void>((resolve) => (release = resolve))
    const events: NormalizedEvent[] = []
    const session = new CodexSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'ext-1' }, (e) => events.push(e))
    expect(session.takeOpenedSettings()).toBeNull()
    release()
    await session.ready
    expect(events.filter((e) => e.type === 'settings_changed')).toEqual([
      { type: 'settings_changed', sessionId: 's1', model: 'gpt-5.5', effort: 'medium', verbosity: null, serviceTier: null, by: 'tool' },
    ])
  })

  it('says nothing when the thread runs what the session shows', async () => {
    state.resumed = { model: 'gpt-5.6-terra', reasoningEffort: 'high' }
    const { handle, events } = await open({ model: 'gpt-5.6-terra', effort: 'high', resumeExternalId: 'ext-1' })
    expect(settingsEvents(events)).toEqual([])
    expect(handle.takeOpenedSettings?.()).toBeNull()
  })

  it('keeps a recorded effort the thread has another of: turns send it', async () => {
    state.resumed = { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
    const { handle } = await open({ model: 'gpt-5.6-terra', effort: 'xhigh', resumeExternalId: 'ext-1' })
    expect(handle.takeOpenedSettings?.()).toBeNull()
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]?.effort).toBe('xhigh')
  })

  it('leaves "default" effort alone when the model matches: Codex answers a default with a concrete value, which is not a choice', async () => {
    state.resumed = { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
    const { handle } = await open({ model: 'gpt-5.6-terra', resumeExternalId: 'ext-1' })
    expect(handle.takeOpenedSettings?.()).toBeNull()
    handle.send('one')
    await tick()
    expect(turnsStarted()[0]).not.toHaveProperty('effort')
  })

  it('does not look at a thread it just started', async () => {
    const { handle } = await open({})
    expect(handle.takeOpenedSettings?.()).toBeNull()
  })
})

describe('a model the provider refuses', () => {
  const body =
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}}'

  it('ends the turn with an error of its own that says retrying cannot help', async () => {
    const { events } = await open({ model: 'gpt-5.5' })
    state.handlers!.onNotification({
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'turn-1', status: 'failed', error: { message: body, additionalDetails: null } } },
    })
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({
      error: { code: 'internal', retryable: false, data: { reason: 'model_rejected', model: 'gpt-5.5' } },
    })
    expect((error as { error: { message: string } }).error.message).toContain("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.")
  })

  it('leaves other failed turns as they were: Codex\'s sentence, retryable', async () => {
    const { events } = await open({})
    state.handlers!.onNotification({
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'turn-1', status: 'failed', error: { message: 'stream closed before response.completed', additionalDetails: null } } },
    })
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: 'internal', message: 'stream closed before response.completed', retryable: true },
    })
  })
})
