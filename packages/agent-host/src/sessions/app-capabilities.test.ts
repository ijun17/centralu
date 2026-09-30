import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type AppPermission, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { brokerSaid, brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * **Where** a capability approval stands (M4 D-4) — checked with a real manager, runtime, app
 * process and store.
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
const answerAgent = () => {
  w.claude.onSend = (h) => {
    h.say('done by the agent')
    h.done()
  }
}

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
  w.answerCapabilities = null
})

afterEach(async () => {
  await w.dispose()
})

describe('a chain started from a session — that session\'s approval card', () => {
  it('a card stands up and the session becomes waiting-for-approval. Allowing it lets the request proceed, and the answer is remembered so it is not asked again', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
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

    w.mgr.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending)).toMatchObject({ isError: false, text: 'done by the agent' })
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)).toMatchObject({ pendingApproval: null })
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', sessionId: caller.id, requestId: card!.requestId, decision: 'allow' }))

    // The memory lives in the store (it survives even if the host restarts) — no card stands for the next request
    expect(w.store.getAppPermission(`${w.projectId}/notes`, 'agent:claude')).toMatchObject({ decision: 'allow', text: 'run an agent (Claude Code) in a new session' })
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
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const denied = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    const [first] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    w.mgr.respondApproval(caller.id, first!.requestId, 'deny')
    expect(brokerSaid(await denied)).toMatchObject({ isError: true })
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })).text).toContain('run_agent refused: the person did not allow App notes')
    expect(capabilityCards(caller.id)).toHaveLength(1)

    const always = w.callFromSession(caller, 'app-notes', { tool: 'host_data', args: { name: 'sessions.list' } })
    const [, second] = await until(() => capabilityCards(caller.id), (c) => c.length === 2)
    w.mgr.respondApproval(caller.id, second!.requestId, 'always', 'session', 'other')
    expect(brokerSaid(await always).isError).toBe(false)
  })

  it('if an adapter\'s card is already standing, this one stands only after that one closes — one session has one card slot', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const h = w.claude.handles.get(caller.id)!
    // The agent is already asking for approval of a different tool
    h.emit({ type: 'approval_request', sessionId: caller.id, requestId: 'req-bash', detail: { kind: 'command', command: 'ls', cwd: w.repo } })
    const pending = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(capabilityCards(caller.id)).toEqual([])
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)!.pendingApproval?.requestId).toBe('req-bash')

    // The person answers the adapter's card — once the adapter announces it closed, our card stands up
    w.mgr.respondApproval(caller.id, 'req-bash', 'allow')
    h.emit({ type: 'approval_resolved', sessionId: caller.id, requestId: 'req-bash', decision: 'allow' })
    const [card] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    w.mgr.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending).isError).toBe(false)
  })

  it('with no answer, the card is withdrawn and refused after 5 minutes (shortened for this test) — nothing is remembered', async () => {
    await w.dispose()
    w = await brokerWorld({ plantApp, PROJECT_APPS }, { capabilityQuestionMs: 400 })
    w.answerCapabilities = null
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const out = brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } }))
    expect(out.text).toContain('run_agent refused: the person did not answer within 1 second whether App notes may run an agent')
    const [card] = capabilityCards(caller.id)
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', sessionId: caller.id, requestId: card!.requestId, decision: 'deny' }))
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)!.pendingApproval).toBeNull()
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
  })
})

describe('a chain started from the UI — that app\'s question', () => {
  it('the question stands in the list and is broadcast. Answering it lets the stalled UI call proceed, and the question disappears', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const pending = w.rt.call(APP(), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, { kind: 'view' })
    const [q] = await until(() => w.mgr.appQuestionList(), (l) => l.length === 1)
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
  })

  it('if the manifest\'s uses changes, a stored answer becomes stale and it asks again — forgetting it also asks again', async () => {
    const dir = w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const ask = async () => {
      const pending = w.rt.call(APP(), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, { kind: 'view' })
      const [q] = await until(() => w.mgr.appQuestionList(), (l) => l.length === 1)
      await w.rpc('apps.answerQuestion', { questionId: q!.id, decision: 'allow' })
      return pending
    }
    await ask()
    const again = w.rt.call(APP(), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, { kind: 'view' })
    expect((await again).status).toBe('ok')
    expect(w.events.filter((e) => e.type === 'external_app_questions_changed')).toHaveLength(2) // it stood up, then closed

    const file = join(dir, 'centralu.app.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), uses: { agent: true, host: ['git.status'] } }))
    w.rt.refresh()
    await until(() => w.rt.permissions(APP()), (l) => l[0]?.current === false)
    await ask()
    await w.rpc('apps.forgetPermission', { appId: 'notes', projectId: w.projectId, capability: 'agent:claude' })
    expect(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })).toEqual([])
    await ask()
  })
})
