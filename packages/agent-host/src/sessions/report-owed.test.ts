import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { ChildOwnership } from './child-ownership.js'
import { managerWorld } from './manager.test-helpers.js'

/**
 * The composer's "Working for <caller>" choice (#1377): who waits for a session's work (`agents.reportOwed`), and the
 * person's choice riding on `agents.send` (`intent`). What each choice does to the report is in paused-reports.test.ts.
 */

let world: ReturnType<typeof managerWorld>
let children: ChildOwnership

beforeEach(() => {
  world = managerWorld()
  children = (world.mgr as unknown as { children: ChildOwnership }).children
})

async function two() {
  const p = (await world.rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
  const make = async (name: string) => {
    const s = (await world.rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await world.rpc('sessions.rename', { sessionId: s.id, name }).catch(() => {})
    return s.id
  }
  return { caller: await make('Orchestrator'), child: await make('Worker') }
}

describe('who waits for a session\'s work (#1377)', () => {
  it('says who holds the report a session owes, and nobody when it owes none', async () => {
    const { caller, child } = await two()
    expect(await world.rpc('agents.reportOwed', { sessionId: child })).toEqual({ owed: null })
    children.markReport(child, caller)
    expect(await world.rpc('agents.reportOwed', { sessionId: child })).toEqual({ owed: { callerId: caller, callerName: expect.any(String) } })
    children.clearReport(child)
    expect(await world.rpc('agents.reportOwed', { sessionId: child })).toEqual({ owed: null })
  })

  it('also for a linked machine\'s session whose report this hub holds', async () => {
    const { caller } = await two()
    expect(await world.rpc('agents.reportOwed', { sessionId: 'm1.w1' })).toEqual({ owed: null })
    children.setLinkedReport('m1.w1', { orchestratorId: caller, busy: false })
    expect(await world.rpc('agents.reportOwed', { sessionId: 'm1.w1' })).toMatchObject({ owed: { callerId: caller } })
  })

  it('a caller that is gone is nobody\'s', async () => {
    const { child } = await two()
    children.markReport(child, 'gone')
    expect(await world.rpc('agents.reportOwed', { sessionId: child })).toEqual({ owed: null })
  })
})

describe('the choice on a message (#1377)', () => {
  it('"Take it over" through agents.send closes the report; "Just asking" and "Add to the task" do not', async () => {
    const { caller, child } = await two()
    children.markReport(child, caller)
    await world.rpc('agents.send', { sessionId: child, text: 'quick question' })
    await world.rpc('agents.send', { sessionId: child, text: 'also this', intent: 'task' })
    expect(children.awaitingReport.get(child)).toBe(caller)
    await world.rpc('agents.send', { sessionId: child, text: 'mine now', intent: 'takeover' })
    expect(children.awaitingReport.has(child)).toBe(false)
  })

  it('the event of the message carries the choice, for a hub that follows the session', async () => {
    const { child } = await two()
    await world.rpc('agents.send', { sessionId: child, text: 'a', intent: 'task' })
    await world.rpc('agents.send', { sessionId: child, text: 'b' })
    await world.rpc('agents.send', { sessionId: child, text: 'c', intent: 'takeover' })
    const seen = world.events.filter((e) => e.type === 'user_message' && e.sessionId === child).map((e) => (e.type === 'user_message' ? e.intent : null))
    expect(seen).toEqual(['task', undefined, 'takeover'])
  })
})
