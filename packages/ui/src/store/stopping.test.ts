import { describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults, STOP_NOT_CONFIRMED_LABEL } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- tests use MockPlatform rather than ad-hoc mocking (platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'

/**
 * Stop is said once the tool confirms it (#1060), so the store remembers the Stop the person pressed until the session
 * leaves working: the button says "Stopping…", and a notice that the Stop has not taken effect gives it its words.
 */
const info = (id: string): SessionInfo => ({
  id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: true,
  state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
  waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
  importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
  appId: null, ...sessionLiveDefaults(),
})
const tick = () => new Promise((r) => setTimeout(r, 0))

async function working(id: string) {
  const mock = new MockPlatform()
  mock.sessions.set(id, info(id))
  await useStore.getState().attach(mock)
  // The tool takes its time to confirm: the interrupt is sent, and nothing comes back yet
  mock.agents.interrupt = async () => {}
  mock.emit({ type: 'state_change', sessionId: id, state: 'working' } as NormalizedEvent)
  await tick()
  expect(useStore.getState().sessions[id]?.state).toBe('working')
  return mock
}

describe('a Stop waiting for the tool (#1060)', () => {
  it('is kept for the turn it was pressed in, until the session leaves working', async () => {
    const mock = await working('stop-a')
    await useStore.getState().interrupt('stop-a')
    const turn = useStore.getState().workingSince['stop-a']
    expect(turn).toBeTypeOf('number')
    expect(useStore.getState().stopping['stop-a']).toEqual({ turn })

    mock.emit({ type: 'state_change', sessionId: 'stop-a', state: 'waiting_input', reason: 'interrupted' } as NormalizedEvent)
    await tick()
    expect(useStore.getState().sessions['stop-a']?.state).toBe('waiting_input')
    // The next turn is a new one: the old Stop is not its own
    mock.emit({ type: 'state_change', sessionId: 'stop-a', state: 'working' } as NormalizedEvent)
    await tick()
    expect(useStore.getState().workingSince['stop-a']).not.toBe(useStore.getState().stopping['stop-a']?.turn)
  })

  it('takes the words of a notice that the Stop has not taken effect, and the session stays working', async () => {
    const mock = await working('stop-b')
    await useStore.getState().interrupt('stop-b')
    const text = 'Claude Code has not confirmed the stop after 10 s. The turn is still running.'
    mock.emit({ type: 'notice', sessionId: 'stop-b', level: 'warning', text, from: 'Centralu', label: STOP_NOT_CONFIRMED_LABEL } as NormalizedEvent)
    await tick()
    expect(useStore.getState().stopping['stop-b']?.failed).toBe(text)
    expect(useStore.getState().sessions['stop-b']?.state).toBe('working')
  })

  it('stays through an approval in the same turn, and goes when the turn ends', async () => {
    const mock = await working('stop-d')
    await useStore.getState().interrupt('stop-d')
    mock.emit({ type: 'approval_request', sessionId: 'stop-d', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/tmp' } } as NormalizedEvent)
    await tick()
    mock.emit({ type: 'approval_resolved', sessionId: 'stop-d', requestId: 'r1' } as NormalizedEvent)
    await tick()
    // Back to working: the clock started again, and the Stop is still this turn's
    expect(useStore.getState().sessions['stop-d']?.state).toBe('working')
    expect(useStore.getState().stopping['stop-d']?.turn).toBe(useStore.getState().workingSince['stop-d'])

    mock.emit({ type: 'state_change', sessionId: 'stop-d', state: 'waiting_input', reason: 'interrupted' } as NormalizedEvent)
    await tick()
    expect(useStore.getState().stopping['stop-d']).toBeUndefined()
  })

  it('a Stop the host refused outright is a toast, and leaves no "Stopping…" behind', async () => {
    const mock = await working('stop-c')
    mock.agents.interrupt = async () => {
      throw new Error('session not found')
    }
    await useStore.getState().interrupt('stop-c')
    expect(useStore.getState().toast).toBe('Could not stop: session not found')
    expect(useStore.getState().stopping['stop-c']).toBeUndefined()
  })
})
