import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp, until } from '../apps/external/test-helpers.js'
import { brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * A chain (M4 D-6) — a session's agent calls an app (notes), notes calls another app (helper), and
 * helper assigns an agent. Checked with a real manager, runtime, two app processes and a store
 * (only the adapter is fake).
 *
 *   cancellation  stopping the session that called stops everything beneath it — even the agent
 *                 session that was running on assignment (an interrupt)
 *   the record    every row of the chain is linked to its parent, so reading one of notes'
 *                 records brings back the entire chain
 */

let w: BrokerWorld

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
})

afterEach(async () => {
  await w.dispose()
})

describe('cancellation and the record for a chain', () => {
  it('stopping the calling session cascades cancellation down the chain, stopping the assigned agent, and every row of the chain closes as cancelled', async () => {
    w.plant('project', 'notes', { apps: ['helper'] })
    w.plant('project', 'helper', { agent: true })
    w.rt.refresh()
    // The agent never answers — it runs until stopped
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

    // Wait until every row of the chain has closed — the assignment's row closes only after the agent session has gone idle
    await until(() => w.rt.runs({ projectId: w.projectId, appId: 'notes' }), (l) => l.length === 3 && l.every((r) => r.status !== 'running'))
    // The whole chain is present in a single record of notes — kept exactly the shape the RPC returns
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
