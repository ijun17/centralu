import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type AppPermission, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { brokerSaid, brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * 능력 승인이 **어디에 서는가** (M4 D-4) — 진짜 매니저·런타임·앱 프로세스·저장소로 본다.
 *
 *   세션에서 시작된 사슬  그 세션의 승인 카드(`approval_request`의 `capability`) — 어댑터의 카드와 같은 자리, 같은 답의 길
 *   화면에서 시작된 사슬  그 앱의 물음(`apps.questions`) — 고정 화면이 그리고 `apps.answerQuestion`으로 답한다
 *
 * 답은 저장소에 기억된다(`app_permissions`). 사람 대신 아무도 답하지 않는다(`answerCapabilities: null`) — 시험이 카드를 보고 답한다.
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

describe('세션에서 시작된 사슬 — 그 세션의 승인 카드', () => {
  it('카드가 서고 세션은 승인 대기가 된다. 허락하면 부탁이 이어지고, 답은 기억되어 다음에는 묻지 않는다', async () => {
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
    // 부탁은 사람을 기다린다 — 아직 에이전트 세션이 없다
    expect(w.agentSessions()).toEqual([])

    w.mgr.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending)).toMatchObject({ isError: false, text: 'done by the agent' })
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)).toMatchObject({ pendingApproval: null })
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', sessionId: caller.id, requestId: card!.requestId, decision: 'allow' }))

    // 기억은 저장소에 있다(host가 다시 떠도 남는다) — 다음 부탁에는 카드가 서지 않는다
    expect(w.store.getAppPermission(`${w.projectId}/notes`, 'agent:claude')).toMatchObject({ decision: 'allow', text: 'run an agent (Claude Code) in a new session' })
    expect(RpcMethods['apps.permissions'].result.parse(await w.rpc('apps.permissions', { appId: 'notes', projectId: w.projectId })) as AppPermission[]).toMatchObject([
      { capability: 'agent:claude', decision: 'allow', current: true, text: 'run an agent (Claude Code) in a new session' },
    ])
    expect(brokerSaid(await w.callFromSession(caller, 'app-notes', { args: { prompt: 'y' } })).isError).toBe(false)
    expect(capabilityCards(caller.id)).toHaveLength(1)
  })

  it('거절하면 부탁은 거절로 끝나고 그 거절도 기억된다. 카드의 "항상 허용"은 허용이다', async () => {
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

  it('어댑터의 카드가 떠 있으면 그것이 닫힌 뒤에 선다 — 한 세션의 카드 자리는 하나다', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const h = w.claude.handles.get(caller.id)!
    // 에이전트가 먼저 다른 도구의 승인을 묻고 있다
    h.emit({ type: 'approval_request', sessionId: caller.id, requestId: 'req-bash', detail: { kind: 'command', command: 'ls', cwd: w.repo } })
    const pending = w.callFromSession(caller, 'app-notes', { args: { prompt: 'x' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(capabilityCards(caller.id)).toEqual([])
    expect(w.mgr.listSessions().find((s) => s.id === caller.id)!.pendingApproval?.requestId).toBe('req-bash')

    // 사람이 어댑터의 카드에 답한다 — 어댑터가 닫았다고 알리면 우리 카드가 선다
    w.mgr.respondApproval(caller.id, 'req-bash', 'allow')
    h.emit({ type: 'approval_resolved', sessionId: caller.id, requestId: 'req-bash', decision: 'allow' })
    const [card] = await until(() => capabilityCards(caller.id), (c) => c.length === 1)
    w.mgr.respondApproval(caller.id, card!.requestId, 'allow')
    expect(brokerSaid(await pending).isError).toBe(false)
  })

  it('답이 없으면 5분(시험은 짧게) 뒤 카드를 거두고 거절한다 — 기억하지 않는다', async () => {
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

describe('화면에서 시작된 사슬 — 그 앱의 물음', () => {
  it('물음이 목록에 서고 방송된다. 답하면 멈춰 있던 화면의 호출이 이어지고 물음은 사라진다', async () => {
    w.plant('project', 'notes', { agent: true })
    w.rt.refresh()
    answerAgent()
    const pending = w.rt.call(APP(), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, { kind: 'view' })
    const [q] = await until(() => w.mgr.appQuestionList(), (l) => l.length === 1)
    // RPC의 답은 프로토콜의 모양 그대로다 (schema smoke와 같은 대조)
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

  it('매니페스트의 uses가 바뀌면 저장된 답도 옛 답이 되어 다시 묻는다 — 잊으면 다시 묻는다', async () => {
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
    expect(w.events.filter((e) => e.type === 'external_app_questions_changed')).toHaveLength(2) // 섰다, 닫혔다

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
