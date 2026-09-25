import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * 사슬 (M4 D-6) — 세션의 에이전트가 앱(notes)을 부르고, notes가 다른 앱(helper)을 부르고, helper가 에이전트를 부탁한다.
 * 진짜 매니저·런타임·앱 프로세스 둘·저장소로 본다(어댑터만 가짜).
 *
 *   취소  사람이 부른 세션을 멈추면 그 아래가 모두 멈춘다 — 부탁받아 돌던 에이전트 세션까지(인터럽트)
 *   기록  사슬의 줄마다 부모가 이어지고, notes의 기록 하나를 읽으면 사슬 전체가 온다
 */

let w: BrokerWorld

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
})

afterEach(async () => {
  await w.dispose()
})

describe('사슬의 취소와 기록', () => {
  it('부른 세션을 멈추면 취소가 사슬을 따라 내려가 부탁받은 에이전트를 멈추고, 사슬의 줄은 모두 취소로 닫힌다', async () => {
    w.plant('project', 'notes', { apps: ['helper'] })
    w.plant('project', 'helper', { agent: true })
    w.rt.refresh()
    // 에이전트는 답하지 않는다 — 멈출 때까지 돈다
    w.claude.onSend = () => {}
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const pending = w.callFromSession(caller, 'app-notes', {
      tool: 'call_app',
      args: { app: 'helper', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'dig into the logs' } } },
    })

    const [agent] = await until(() => w.agentSessions(), (l) => l.length === 1)
    const handle = await until(() => w.claude.handles.get(agent!.id), (h) => h !== undefined && h.sent.length === 1)
    expect(handle!.interrupted).toBe(false)

    w.mgr.interrupt(caller.id)
    const out = await pending
    expect(out.isError).toBe(true)
    expect(handle!.interrupted).toBe(true)
    await until(() => w.mgr.listSessions().find((s) => s.id === agent!.id)?.state, (s) => s === 'idle')

    // 사슬의 줄이 모두 닫힐 때까지 — 에이전트 세션을 쉬게 둔 뒤에 부탁의 줄이 닫힌다
    await until(() => w.rt.runs({ projectId: w.projectId, appId: 'notes' }), (l) => l.length === 3 && l.every((r) => r.status !== 'running'))
    // notes의 기록 하나에 사슬 전체가 — RPC가 돌려주는 모양 그대로
    const runs = RpcMethods['apps.runs'].result.parse(await w.rpc('apps.runs', { appId: 'notes', projectId: w.projectId }))
    const notesRun = runs.find((r) => r.appId === 'notes')!
    const helperRun = runs.find((r) => r.appId === 'helper' && r.kind === 'tool')!
    const agentRun = runs.find((r) => r.kind === 'broker')!
    expect(runs).toHaveLength(3)
    expect(notesRun).toMatchObject({ kind: 'tool', tool: 'ask_broker', callerKind: 'session', callerSessionId: caller.id, parentRunId: null, status: 'cancelled' })
    expect(helperRun).toMatchObject({ tool: 'ask_broker', callerKind: 'app', parentRunId: notesRun.id, status: 'cancelled' })
    expect(agentRun).toMatchObject({ appId: 'helper', tool: 'run_agent', parentRunId: helperRun.id, status: 'cancelled', sessionId: agent!.id })
  })
})
