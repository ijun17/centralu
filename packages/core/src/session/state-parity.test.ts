/**
 * The host's copy of a session's state agrees with the window's (#428).
 *
 * The window holds the live state (core `applyEvent`); the host keeps its own copy for a window that reconnects and
 * for the next host after a swap (`applySessionState`, protocol session-state.ts, which the host's `applyStateHint`
 * and the mock's list run). The same event sequences go to both, and the fields a reconnect hands back must come out
 * the same after every event. The host's hand-copied table drifted before:
 * a question did not block the session, a `turn_complete` in idle ended a turn that never began, a limit came
 * down on every hint, and an answered card next to another one released the session.
 */
import { describe, expect, it } from 'vitest'
import { applySessionState, type NormalizedEvent, type SessionInfo, type SessionState } from '@cc/protocol'
import { applyEvent, initialSession, type SessionSummary } from './reducer.js'

const sessionId = 's1'
const ev = (e: Record<string, unknown> & { type: NormalizedEvent['type'] }) => ({ sessionId, ...e }) as NormalizedEvent

const E = {
  delta: ev({ type: 'message_delta', role: 'assistant', text: 'hi' }),
  call: ev({ type: 'tool_call', callId: 'c1', summary: { kind: 'other', title: 'Read' } }),
  result: ev({ type: 'tool_result', callId: 'c1', ok: true, summary: '' }),
  approval: (id: string) => ev({ type: 'approval_request', requestId: id, detail: { kind: 'other', title: 'x' } }),
  approved: (id: string) => ev({ type: 'approval_resolved', requestId: id, decision: 'allow' }),
  question: (id: string) => ev({ type: 'question_request', requestId: id, questions: [] }),
  answered: (id: string) => ev({ type: 'question_resolved', requestId: id }),
  done: ev({ type: 'turn_complete' }),
  limit: ev({ type: 'limit_reached', usedPercent: 100 }),
  error: ev({ type: 'error', error: { code: 'internal', message: 'boom' } }),
  state: (state: SessionState) => ev({ type: 'state_change', state }),
  activity: ev({ type: 'activity', activity: 'compacting' }),
  usage: ev({ type: 'usage_update', tokens: { input: 1, output: 1 } }),
}

/** What a reconnect hands back, from either side */
const facts = (s: Pick<SessionSummary, 'state' | 'waitingSince' | 'limit' | 'activity' | 'pendingApproval' | 'pendingQuestions'>) => ({
  state: s.state,
  waitingSince: s.waitingSince,
  limit: s.limit,
  activity: s.activity,
  approval: s.pendingApproval?.requestId ?? null,
  questions: s.pendingQuestions.map((q) => q.requestId),
})

/** Feeds the same events to both sides, comparing after every one */
function run(events: NormalizedEvent[], start: SessionState = 'idle'): ReturnType<typeof facts> {
  let ui = initialSession({ id: sessionId, projectId: 'p', name: 'n', tool: 'claude', state: start })
  const host = {
    id: sessionId, state: start, waitingSince: null, limit: null, activity: null, pendingApproval: null, pendingQuestions: [],
  } as unknown as SessionInfo
  events.forEach((e, i) => {
    const now = 1_000 + i
    ui = applyEvent(ui, e, now)
    applySessionState(host, e, now)
    expect(facts(host), `after ${events.slice(0, i + 1).map((x) => x.type).join(' → ')}`).toEqual(facts(ui))
  })
  return facts(ui)
}

describe('the host keeps the state the window shows', () => {
  it('a question blocks the session, and answering it puts it back to work', () => {
    expect(run([E.delta, E.question('q1')]).state).toBe('waiting_approval')
    expect(run([E.delta, E.question('q1'), E.answered('q1')]).state).toBe('working')
  })

  it('a turn_complete with no turn changes nothing', () => {
    expect(run([E.done])).toMatchObject({ state: 'idle', waitingSince: null })
  })

  it('a tool result starts nothing: a late one after the turn leaves the session at rest', () => {
    // A background agent's card released as its process closes (claude releaseAgents), or a set-aside handle's result
    expect(run([E.delta, E.done, E.result])).toMatchObject({ state: 'waiting_input', waitingSince: 1_001 })
    expect(run([E.result]).state).toBe('idle')
    // Nor does one finishing beside a call that waits on the person release the session from that card
    expect(run([E.delta, E.approval('a1'), E.result])).toMatchObject({ state: 'waiting_approval', approval: 'a1' })
  })

  it('a limit stays until the session leaves limited', () => {
    expect(run([E.limit, E.state('idle')])).toMatchObject({ state: 'idle', limit: { usedPercent: 100 } })
    expect(run([E.delta, E.done, E.limit]).state).toBe('waiting_input')
  })

  it('answering one card leaves the session blocked on the other', () => {
    expect(run([E.delta, E.approval('a1'), E.question('q1'), E.approved('a1')])).toMatchObject({ state: 'waiting_approval', questions: ['q1'] })
    expect(run([E.delta, E.question('q1'), E.question('q2'), E.answered('q1')])).toMatchObject({ state: 'waiting_approval', questions: ['q2'] })
  })

  it('the same question arriving again replaces its card', () => {
    expect(run([E.delta, E.question('q1'), E.question('q1')]).questions).toEqual(['q1'])
  })

  it('a limit report does not take a session off the card it waits on', () => {
    // Codex reports its rate limits at any time (account/rateLimits/updated)
    expect(run([E.delta, E.question('q1'), E.limit])).toMatchObject({ state: 'waiting_approval', waitingSince: 1_001, questions: ['q1'], limit: { usedPercent: 100 } })
  })

  /*
   * What the host states itself goes out as a state_change, and the host now applies that same statement to its copy
   * (manager `settleState`) rather than writing the state by hand.
   */
  it('the host\'s own statements read the same: resume, tool change, failed re-attach, a card\'s answer and rest', () => {
    // A resume or a tool change after a limit, an error or a finished turn: idle, and the banners come down
    expect(run([E.delta, E.limit, E.state('idle')])).toMatchObject({ state: 'idle', waitingSince: null, limit: null })
    expect(run([E.delta, E.error, E.state('idle')])).toMatchObject({ state: 'idle', waitingSince: null })
    expect(run([E.delta, E.activity, E.done, E.state('idle')])).toMatchObject({ state: 'idle', activity: null })
    // A failed re-attach of a session mid-turn, with its card still standing: idle, the dead card gone
    expect(run([E.delta, E.approval('a1'), E.state('idle')])).toMatchObject({ state: 'idle', approval: null })
    // respondApproval for a host card raised in a turn: its resolve, then "working" when nothing else is open
    expect(run([E.delta, E.approval('h1'), E.approved('h1'), E.state('working')])).toMatchObject({ state: 'working', approval: null })
    // restAfterCard for one raised between turns: the rest first, then the resolve, which changes nothing
    expect(run([E.delta, E.done, E.approval('h1'), E.state('waiting_input'), E.approved('h1')])).toMatchObject({ state: 'waiting_input', approval: null })
  })

  it('a host card raised in limited closes back into limited (#673)', () => {
    // `raiseHostAsks` / `restAfterCard` (host-cards.ts): the rest is set before the card's resolve
    expect(run([E.delta, E.limit, E.approval('h1'), E.state('limited'), E.approved('h1')])).toMatchObject({ state: 'limited', approval: null })
  })

  it('a wait keeps the time it began across waiting states', () => {
    expect(run([E.delta, E.approval('a1'), E.done]).waitingSince).toBe(1_001)
  })

  /*
   * Every sequence the rules could meet, not only the ones above: a seeded walk over the events both sides read,
   * so a rule added to one side and not the other shows up here without anyone thinking of its case.
   */
  it('agrees on seeded random sequences', () => {
    const pool: NormalizedEvent[] = [
      E.delta, E.call, E.result, E.approval('a1'), E.approval('a2'), E.approved('a1'), E.approved('a2'),
      E.question('q1'), E.question('q2'), E.answered('q1'), E.answered('q2'), E.done, E.limit, E.error,
      E.activity, E.usage,
      ...(['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'] as const).map(E.state),
    ]
    let seed = 428
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31
    for (let n = 0; n < 400; n++) {
      const start = (['idle', 'working', 'waiting_input'] as const)[Math.floor(next() * 3)]
      run(Array.from({ length: 25 }, () => pool[Math.floor(next() * pool.length)]!), start)
    }
  })
})
