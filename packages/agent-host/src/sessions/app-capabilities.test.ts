import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type AppPermission, type NormalizedEvent, type PermissionPreset, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { brokerSaid, brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * **Whether** and **where** a capability approval stands (M4 D-4, #2237) — checked with a real
 * manager, runtime, app process and store.
 *
 * Whether: what an app declares runs with no card, unless the lowest preset among the calls open
 * into the app is `safe` (`AppSessions.callersPreset`, the reading that also holds the app's agent).
 * Where, when it is asked:
 *
 *   a chain started from a session  that session's approval card (`approval_request`'s
 *                                   `capability`) — the same spot, the same answer path, as an
 *                                   adapter's own card
 *   a chain started from the UI     that app's question (`apps.questions`) — drawn by a fixed
 *                                   screen and answered through `apps.answerQuestion`
 *
 * The answer is remembered in the store (`app_permissions`). Nobody answers in place of the person
 * (`answerCapabilities: null`) — the test inspects the card and answers it itself.
 */

let w: BrokerWorld

const APP = () => ({ projectId: w.projectId, appId: 'notes' })
const capabilityCards = (sessionId: string) =>
  w.events.filter((e): e is Extract<NormalizedEvent, { type: 'approval_request' }> => e.type === 'approval_request' && e.sessionId === sessionId && e.detail.kind === 'capability')
const allCapabilityCards = () => w.events.filter((e) => e.type === 'approval_request' && e.detail.kind === 'capability')
const answerAgent = () => {
  w.claude.onSend = (h) => {
    h.say('done by the agent')
    h.done()
  }
}
const session = async (permissionPreset?: PermissionPreset) =>
  (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude', ...(permissionPreset ? { permissionPreset } : {}) })) as SessionInfo
/** A call a `safe` session holds open into the app (its `slow` tool) until the returned function ends it */
const safeCallOpen = async () => {
  const s = await session('safe')
  const stop = new AbortController()
  const call = w.appCall(s, 'app-notes', 'slow', {}, { signal: stop.signal })
  await until(() => w.rt.runs(APP()).filter((r) => r.tool === 'slow' && r.status === 'running'), (r) => r.length === 1)
  return async () => {
    stop.abort()
    await call.catch(() => {})
  }
}
const viewAsksForAgent = () => w.rt.call(APP(), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, { kind: 'view' })

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
  w.answerCapabilities = null
})

afterEach(async () => {
  await w.dispose()
})

describe('no caller under safe — the declaration is the consent (#2237)', () => {
  it('a session under the default preset: the app runs its agent with no card, and nothing is remembered', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = await session()
    expect(caller.permissionPreset).not.toBe('safe')
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } }))).toMatchObject({ isError: false, text: 'done by the agent' })
    expect(allCapabilityCards()).toEqual([])
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
  })

  it('a screen the person opened, with no session calling in: no question', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    expect((await viewAsksForAgent()).status).toBe('ok')
    expect(w.events.filter((e) => e.type === 'external_app_questions_changed')).toEqual([])
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
  })

  it('a remembered deny still refuses a session under the default preset, without a card', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    w.store.permissions.putAppPermission(`${w.projectId}/notes`, w.projectId, { capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session', decision: 'deny', stamp: 'from an older build', decidedAt: 1 })
    const caller = await session()
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })).text).toContain('run_agent refused: the person did not allow App notes')
    expect(allCapabilityCards()).toEqual([])
    expect(w.agentSessions()).toEqual([])
  })
})

// The calling session is under safe in these: otherwise no card stands (above)
describe('a chain started from a session — that session\'s approval card', () => {
  it('a card stands up and the session becomes waiting-for-approval. Allowing it lets the request proceed, and the answer is remembered so it is not asked again', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = await session('safe')
    const pending = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })

    const [card] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    expect(card!.detail).toEqual({
      kind: 'capability',
      app: { appId: 'notes', projectId: w.projectId, name: 'App notes' },
      capability: 'agent:claude',
      text: 'run an agent (Claude Code) in a new session',
    })
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)).toMatchObject({ state: 'waiting_approval', pendingApproval: { requestId: card!.requestId } })
    // The request waits on the person — there is no agent session yet
    expect(w.agentSessions()).toEqual([])

    w.mgr.inputs.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending)).toMatchObject({ isError: false, text: 'done by the agent' })
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)).toMatchObject({ pendingApproval: null })
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', sessionId: caller.id, requestId: card!.requestId, decision: 'allow' }))

    // The memory lives in the store (it survives even if the host restarts) — no card stands for the next request
    expect(w.store.permissions.getAppPermission(`${w.projectId}/notes`, 'agent:claude')).toMatchObject({ decision: 'allow', text: 'run an agent (Claude Code) in a new session' })
    expect(RpcMethods['apps.permissions'].result.parse(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })) as AppPermission[]).toMatchObject([
      { capability: 'agent:claude', decision: 'allow', current: true, text: 'run an agent (Claude Code) in a new session' },
    ])
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'y' } })).isError).toBe(false)
    expect(capabilityCards(caller.id)).toHaveLength(1)
  })

  it('denying it ends the request in a refusal, and that refusal is also remembered. A card\'s "always allow" is an allow', async () => {
    w.plant('project', 'notes', { agent: true, host: ['sessions.list'] })
    w.rt.refresh()
    answerAgent()
    const caller = await session('safe')
    const denied = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    const [first] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    w.mgr.inputs.respondApproval(caller.id, first!.requestId, 'deny')
    expect(brokerSaid(await denied)).toMatchObject({ isError: true })
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })).text).toContain('run_agent refused: the person did not allow App notes')
    expect(brokerSaid(await w.callFromSession(await session('normal'), 'app-notes', { args: { prompt: 'x' } })).text).toContain('run_agent refused: the person did not allow App notes')
    expect(allCapabilityCards()).toHaveLength(1)

    const always = w.callFromSession(caller, 'app-notes', { tool: 'host_data', args: { name: 'sessions.list' } })
    const [, second] = await until(() => capabilityCards(caller.id), (c) => c.length === 2)
    w.mgr.inputs.respondApproval(caller.id, second!.requestId, 'always', 'session', 'other')
    expect(brokerSaid(await always).isError).toBe(false)
  })

  it('a call_app chain asks in the session that started it for the called app\'s request when that session is under safe, and runs unasked otherwise', async () => {
    w.plant('project', 'notes', { apps: ['other'] })
    w.plant('project', 'other', { agent: true })
    w.rt.refresh()
    answerAgent()
    w.answerCapabilities = 'allow'
    const chain = { tool: 'call_app', args: { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } } }
    expect(brokerSaid(await w.callFromSession(await session(), 'app-notes', chain)).isError).toBe(false)
    expect(allCapabilityCards()).toEqual([])
    const caller = await session('safe')
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', chain)).isError).toBe(false)
    expect(capabilityCards(caller.id).map((c) => c.detail.kind === 'capability' && [c.detail.app.appId, c.detail.capability])).toEqual([
      ['notes', `app:${w.projectId}/other`],
      ['other', 'agent:claude'],
    ])
  })

  it('if an adapter\'s card is already standing, this one stands only after that one closes — one session has one card slot', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = await session('safe')
    const h = w.claude.handles.get(caller.id)!
    // The agent is already asking for approval of a different tool
    h.emit({ type: 'approval_request', sessionId: caller.id, requestId: 'req-bash', detail: { kind: 'command', command: 'ls', cwd: w.repo } })
    const pending = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(capabilityCards(caller.id)).toEqual([])
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)!.pendingApproval?.requestId).toBe('req-bash')

    // The person answers the adapter's card — once the adapter announces it closed, our card stands up
    w.mgr.inputs.respondApproval(caller.id, 'req-bash', 'allow')
    h.emit({ type: 'approval_resolved', sessionId: caller.id, requestId: 'req-bash', decision: 'allow' })
    const [card] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    w.mgr.inputs.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending).isError).toBe(false)
  })

  it('with no answer, the card is withdrawn and refused after 5 minutes (shortened for this test) — nothing is remembered', async () => {
    await w.dispose()
    w = await brokerWorld({ plantApp, PROJECT_APPS }, { capabilityQuestionMs: 400 })
    w.answerCapabilities = null
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    const caller = await session('safe')
    const out = brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } }))
    expect(out.text).toContain('run_agent refused: the person did not answer within 400 milliseconds whether App notes may run an agent')
    const [card] = capabilityCards(caller.id)
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', sessionId: caller.id, requestId: card!.requestId, decision: 'deny' }))
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)!.pendingApproval).toBeNull()
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
  })

  /*
   * A decision a newer build recorded in a word this one does not know (#384) is a permission this build cannot read:
   * it refuses, as it does for anything but `allow`, whoever calls and whatever the uses, and the record stays as it is
   * for the build that wrote it.
   */
  it('a stored decision this build does not know refuses, without asking, and is left as it was', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const key = `${w.projectId}/notes`
    // The type holds this build's words only; a newer build's row holds another
    w.store.permissions.putAppPermission(key, w.projectId, { capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session', decision: 'allow-this-week' as 'allow', stamp: 'any', decidedAt: 1 })
    for (const preset of ['safe', 'auto'] as const) {
      expect(brokerSaid(await w.callFromSession(await session(preset), 'app-notes', { args: { prompt: 'x' } }))).toMatchObject({
        isError: true,
        text: expect.stringContaining('run_agent refused: the person did not allow'),
      })
    }
    expect(allCapabilityCards()).toEqual([])
    expect(w.store.permissions.getAppPermission(key, 'agent:claude')).toMatchObject({ decision: 'allow-this-week' })
  })

  it('if the manifest\'s uses changes, a remembered allow becomes stale and it asks again — forgetting it also asks again', async () => {
    const dir = w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    w.answerCapabilities = 'allow'
    const caller = await session('safe')
    const ask = () => w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    await ask()
    await ask()
    expect(capabilityCards(caller.id)).toHaveLength(1)

    const file = join(dir, 'centralu.app.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), uses: { agent: true, host: ['git.status'] } }))
    w.rt.refresh()
    await until(() => w.rt.permissions(APP()), (l) => l[0]?.current === false)
    // A session not under safe is not asked about the stale allow
    expect(brokerSaid(await w.callFromSession(await session(), 'app-notes', { args: { prompt: 'x' } })).isError).toBe(false)
    expect(allCapabilityCards()).toHaveLength(1)
    await ask()
    expect(capabilityCards(caller.id)).toHaveLength(2)
    await w.rpc('apps.forgetPermission', { appId: 'notes', projectId: w.projectId, capability: 'agent:claude' })
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
    await ask()
    expect(capabilityCards(caller.id)).toHaveLength(3)
  })
})

// A session under safe holds a call open into the app in these: otherwise no question stands (above)
describe('a chain started from the UI — that app\'s question', () => {
  it('the question stands in the list and is broadcast. Answering it lets the stalled UI call proceed, and the question disappears', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const release = await safeCallOpen()
    const pending = viewAsksForAgent()
    const [q] = await until(() => w.mgr.hostCards.appQuestionList(), (l) => l.length === 1)
    // The RPC's answer keeps exactly the protocol's shape (the same kind of check as a schema smoke test)
    expect(RpcMethods['apps.questions'].result.parse(await w.rpc('apps.questions', {}))).toEqual([q])
    expect(q).toMatchObject({
      app: { appId: 'notes', projectId: w.projectId, name: 'App notes' },
      capability: 'agent:claude',
      text: 'run an agent (Claude Code) in a new session',
      origin: { appId: 'notes', projectId: w.projectId },
    })
    expect(q!.expiresAt - q!.askedAt).toBe(5 * 60_000)
    expect(w.events.filter((e) => e.type === 'external_app_questions_changed')).toHaveLength(1)

    await w.rpc('apps.answerQuestion', { questionId: q!.id, decision: 'allow' })
    const out = await pending
    expect((out.result!.structuredContent as { text: string }).text).toBe('done by the agent')
    expect(await w.rpc('apps.questions', {})).toEqual([])
    await expect(w.rpc('apps.answerQuestion', { questionId: q!.id, decision: 'allow' })).rejects.toThrow('That question is no longer open')
    await release()
  })
})
