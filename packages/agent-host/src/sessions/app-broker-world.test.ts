import { afterEach, describe, expect, it } from 'vitest'
import { errorMessage, type SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/*
 * #1354: a fake agent answers a send on a timer. A test that ended with a send still unanswered let the timer fire
 * after the world had closed its store, and the run failed on an unhandled `The database connection is not open` with every
 * test passing. The world now lets the timers land before it closes the store, and one asked for after that fails by name.
 */

let w: BrokerWorld | null = null

afterEach(async () => {
  // Only reached with a world the test did not dispose itself
  await w?.dispose()
  w = null
})

async function session(world: BrokerWorld, tool: 'claude' | 'codex' = 'claude'): Promise<SessionInfo> {
  return (await world.rpc('agents.createSession', { projectId: world.projectId, cwd: world.repo, tool })) as SessionInfo
}

/** What the app-agents test does from its fake agent: a write to the store */
function markRead(world: BrokerWorld, sessionId: string, outcomes: string[]): void {
  try {
    world.store.sessions.markRead(sessionId, 0)
    outcomes.push('written')
  } catch (e) {
    outcomes.push(`failed: ${errorMessage(e)}`)
  }
}

describe('the broker world and the fake agent\'s timers (#1354)', () => {
  it('an answer still to come when the world is disposed lands while the store is open', async () => {
    const world = (w = await brokerWorld({ plantApp, PROJECT_APPS }))
    // Slower than the world's whole disposal, so the answer cannot land before the store is closed by luck
    world.claude.answerDelayMs = 300
    const s = await session(world)
    const outcomes: string[] = []
    world.claude.onSend = (h) => markRead(world, h.sessionId, outcomes)
    await world.rpc('agents.send', { sessionId: s.id, text: 'hello' })
    expect(world.claude.handles.get(s.id)!.sent).toEqual(['hello'])

    await world.dispose()
    w = null

    // The answer was waited for, not left to fire on a closed store
    expect(outcomes).toEqual(['written'])
  })

  it('an answer that starts another agent\'s answer is waited for too', async () => {
    const world = (w = await brokerWorld({ plantApp, PROJECT_APPS }))
    world.claude.answerDelayMs = 100
    world.codex.answerDelayMs = 100
    const first = await session(world, 'claude')
    const second = await session(world, 'codex')
    const outcomes: string[] = []
    world.codex.onSend = (h) => markRead(world, h.sessionId, outcomes)
    // The first agent's answer sends to the second, which answers 100 ms later still
    world.claude.onSend = () => world.codex.handles.get(second.id)!.send('relayed')
    await world.rpc('agents.send', { sessionId: first.id, text: 'hello' })

    await world.dispose()
    w = null

    expect(outcomes).toEqual(['written'])
  })

  it('a send after the world was disposed fails by name instead of reaching a closed store', async () => {
    const world = (w = await brokerWorld({ plantApp, PROJECT_APPS }))
    const s = await session(world)
    const handle = world.claude.handles.get(s.id)!
    await world.dispose()
    w = null

    expect(() => handle.send('too late')).toThrow(/asked for after its world was disposed/)
  })
})
