import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { applyEvent, detectFileConflicts, initialSession, markRead, rename } from './reducer.js'

const NOW = 1_000_000
const s0 = () => initialSession({ id: 's1', projectId: 'p1', name: 'new session' })
const ev = (e: Record<string, unknown>) => ({ sessionId: 's1', ...e }) as NormalizedEvent

/** The event sequence of one real turn (in the order observed in the spike) */
const TURN: NormalizedEvent[] = [
  ev({ type: 'message_delta', role: 'assistant', text: 'the task ' }),
  ev({ type: 'tool_call', callId: 'c1', summary: { tool: 'Bash', title: 'npm run build', readOnly: false, paths: [] } }),
  ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'npm run build', cwd: '/p' } }),
  ev({ type: 'approval_resolved', requestId: 'r1', decision: 'allow' }),
  ev({ type: 'tool_result', callId: 'c1', ok: true, summary: 'exit 0' }),
  ev({ type: 'usage_update', tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
  ev({ type: 'turn_complete' }),
]

const replay = (events: NormalizedEvent[], now = NOW) => events.reduce((s, e) => applyEvent(s, e, now), s0())

describe('replaying an event sequence', () => {
  it('replaying one turn ends in awaiting response', () => {
    const s = replay(TURN)
    expect(s.state).toBe('waiting_input')
    expect(s.pendingApproval).toBeNull()
    expect(s.usage?.outputTokens).toBe(5)
  })

  it('while an approval is requested, waiting_approval + pendingApproval are kept', () => {
    const s = replay(TURN.slice(0, 3))
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r1')
  })

  it('a resolved for a different requestId does not clear pending', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'approval_resolved', requestId: 'other', decision: 'allow' }), NOW)
    expect(s.pendingApproval?.requestId).toBe('r1')
  })

  it('a replay that is not idempotent is safe too (the same events twice)', () => {
    const once = replay(TURN)
    const twice = replay([...TURN, ...TURN])
    expect(twice.state).toBe(once.state)
  })
})

describe('when a wait started (what the inbox order is based on)', () => {
  it('is recorded on entering a wait', () => {
    const s = replay(TURN, NOW)
    expect(s.waitingSince).toBe(NOW)
  })

  it('keeps the first time across transitions between waiting states', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'approval_request', requestId: 'r', detail: { kind: 'other', raw: '{}' } }), NOW)
    const first = s.waitingSince
    s = applyEvent(s, ev({ type: 'error', error: { code: 'internal', message: 'x', retryable: false } }), NOW + 5000)
    expect(s.waitingSince).toBe(first)
  })

  it('is reset when work resumes', () => {
    let s = replay(TURN)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: 'again' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.waitingSince).toBeNull()
  })
})

describe('approvals and questions arriving right after a resume (if the state table swallows them, the agent is blocked forever)', () => {
  it('an approval_request arriving in idle still surfaces as a wait', () => {
    const s = applyEvent(s0(), ev({ type: 'approval_request', requestId: 'r9', detail: { kind: 'command', command: 'npm i', cwd: '/p' } }), NOW)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r9')
    expect(s.waitingSince).toBe(NOW)
  })

  it('so does a question_request in idle', () => {
    const s = applyEvent(s0(), ev({ type: 'question_request', requestId: 'q9', questions: [{ question: '?', header: '', options: [], multiSelect: false }] }), NOW)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingQuestions).toHaveLength(1)
    expect(s.waitingSince).toBe(NOW)
  })

  it('an approval request arriving in waiting_input (after the turn ended) is not swallowed either', () => {
    const s = applyEvent(replay(TURN), ev({ type: 'approval_request', requestId: 'r10', detail: { kind: 'other', raw: '{}' } }), NOW + 1)
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval?.requestId).toBe('r10')
  })
})

describe('an interrupt while waiting for approval (no dead-end states)', () => {
  it('a turn_complete in waiting_approval gets out to waiting_input', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'turn_complete' }), NOW)
    expect(s.state).toBe('waiting_input')
  })

  it('getting out also clears the dead approval and question cards — clicking one would answer a dead requestId', () => {
    const waiting = applyEvent(
      applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'question_request', requestId: 'q1', questions: [] }), NOW),
      ev({ type: 'turn_complete' }),
      NOW,
    )
    expect(waiting.state).toBe('waiting_input')
    expect(waiting.pendingApproval).toBeNull()
    expect(waiting.pendingQuestions).toEqual([])
  })
})

/*
 * A card lives only while it can be answered — error is not the only way a requestId dies.
 * A resume (back to idle) and working resuming finish that request off too, so the cards are cleared with it.
 * If the state (visibility) and the payload (whether it can be acted on) drift apart, cards that cannot be
 * answered are left behind.
 */
describe('cards are cleared on recovery (back to idle or working)', () => {
  it('waiting_approval → idle (resume) clears the approval card', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'state_change', state: 'idle', reason: 'resumed' }), NOW)
    expect(s.state).toBe('idle')
    expect(s.pendingApproval).toBeNull()
  })

  it('waiting_approval → working resuming clears the card (the host sends a still-valid request again)', () => {
    const s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'message_delta', role: 'assistant', text: 'continuing' }), NOW)
    expect(s.state).toBe('working')
    expect(s.pendingApproval).toBeNull()
  })

  it('a new approval request is set up again on top of the clearing', () => {
    const idle = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'state_change', state: 'idle', reason: 'resumed' }), NOW)
    const again = applyEvent(idle, ev({ type: 'approval_request', requestId: 'r2', detail: { kind: 'command', command: 'ls', cwd: '/' } }), NOW)
    expect(again.state).toBe('waiting_approval')
    expect(again.pendingApproval?.requestId).toBe('r2')
  })
})

describe('session name (FR-18)', () => {
  it('an automatic name is updated by session_title', () => {
    const s = applyEvent(s0(), ev({ type: 'session_title', title: 'auth refactor' }), NOW)
    expect(s.name).toBe('auth refactor')
  })

  it('automatic updates stop after a manual change', () => {
    const s = applyEvent(rename(s0(), 'the name I chose'), ev({ type: 'session_title', title: 'auto' }), NOW)
    expect(s.name).toBe('the name I chose')
  })

  /*
   * A name the person changed has to reach the other screens **however many times it is changed** (issue #5).
   * It used to be decided by looking only at this side's own autoNamed, so from the second change on it was
   * quietly dropped.
   */
  it('a name the person chose (auto:false) updates a session that is already manual too', () => {
    const once = applyEvent(s0(), ev({ type: 'session_title', title: 'Guard MCP', auto: false }), NOW)
    expect(once).toMatchObject({ name: 'Guard MCP', autoNamed: false })
    const twice = applyEvent(once, ev({ type: 'session_title', title: 'Guard MCP 2', auto: false }), NOW)
    expect(twice.name).toBe('Guard MCP 2')
  })

  it('an automatic name arriving after a name the person chose is dropped', () => {
    const named = applyEvent(s0(), ev({ type: 'session_title', title: 'Guard MCP', auto: false }), NOW)
    const s = applyEvent(named, ev({ type: 'session_title', title: 'This session is being continued…', auto: true }), NOW)
    expect(s.name).toBe('Guard MCP')
  })
})

describe('what it is busy with (activity)', () => {
  const working = () => applyEvent(s0(), ev({ type: 'state_change', state: 'working' }), NOW)

  it('records that it is compacting, but the state is still working', () => {
    const s = applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW)
    expect(s.activity).toBe('compacting')
    // Not adding a state is the point — code that checks state === 'working' has to stay correct as it is
    expect(s.state).toBe('working')
  })

  it('activity ends when the turn ends — even if the tool never says it has finished', () => {
    const s = applyEvent(
      applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW),
      ev({ type: 'turn_complete' }),
      NOW,
    )
    expect(s.activity).toBeNull()
  })

  it('dying of an error while compacting does not leave "Compacting" behind', () => {
    const s = applyEvent(
      applyEvent(working(), ev({ type: 'activity', activity: 'compacting' }), NOW),
      ev({ type: 'error', error: { code: 'adapter_crashed', message: 'process exited', retryable: true } }),
      NOW,
    )
    expect(s.activity).toBeNull()
  })
})

describe('limits, context and errors', () => {
  it('limit_reached leaves the limited state and the information about when it lifts', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'limit_reached', resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 }), NOW)
    expect(s.state).toBe('limited')
    expect(s.limit).toEqual({ resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 })
  })

  it('the limit information is cleared on returning to working', () => {
    let s = applyEvent(applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW), ev({ type: 'limit_reached' }), NOW)
    s = applyEvent(s, ev({ type: 'state_change', state: 'working' }), NOW)
    expect(s.limit).toBeNull()
  })

  it('keeps the context gauge values (FR-14)', () => {
    const s = applyEvent(s0(), ev({ type: 'context_update', used: 84000, window: 200000, exactness: 'exact' }), NOW)
    expect(s.context).toEqual({ used: 84000, window: 200000, exactness: 'exact' })
  })

  it('a conversation reset empties the context gauge without moving the state (#304)', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'context_update', used: 15967, window: 200000, exactness: 'exact' }), NOW)
    s = applyEvent(s, ev({ type: 'conversation_reset', trigger: 'clear' }), NOW)
    expect(s.context).toBeNull()
    expect(s.state).toBe('working')
  })

  it('an error leaves the error state and its message', () => {
    const s = applyEvent(s0(), ev({ type: 'error', error: { code: 'adapter_crashed', message: 'died', retryable: true } }), NOW)
    expect(s.state).toBe('error')
    expect(s.lastError).toEqual({ code: 'adapter_crashed', message: 'died' })
  })

  it('resuming from limited with a message_delta also clears the limit banner', () => {
    let s = applyEvent(s0(), ev({ type: 'message_delta', role: 'assistant', text: 'x' }), NOW)
    s = applyEvent(s, ev({ type: 'limit_reached', resumeAt: '2026-08-15T14:30:00Z' }), NOW)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: 'resuming' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.limit).toBeNull()
  })

  it('recovering from error clears the lastError banner', () => {
    let s = applyEvent(s0(), ev({ type: 'error', error: { code: 'adapter_crashed', message: 'died', retryable: true } }), NOW)
    s = applyEvent(s, ev({ type: 'message_delta', role: 'assistant', text: 'survived' }), NOW + 1000)
    expect(s.state).toBe('working')
    expect(s.lastError).toBeNull()
  })

  it('returning to idle is recovery too — limit and lastError do not remain', () => {
    let s = applyEvent(s0(), ev({ type: 'error', error: { code: 'internal', message: 'x', retryable: false } }), NOW)
    s = applyEvent(s, ev({ type: 'state_change', state: 'idle' }), NOW)
    expect(s.lastError).toBeNull()
  })

  it('entering error clears the dead approval and question cards (their requestId is dead)', () => {
    let s = applyEvent(replay(TURN.slice(0, 3)), ev({ type: 'question_request', requestId: 'q1', questions: [{ question: '?', header: '', options: [], multiSelect: false }] }), NOW)
    expect(s.pendingApproval).not.toBeNull()
    expect(s.pendingQuestions).toHaveLength(1)
    s = applyEvent(s, ev({ type: 'error', error: { code: 'adapter_crashed', message: 'process exited', retryable: true } }), NOW)
    expect(s.state).toBe('error')
    expect(s.pendingApproval).toBeNull()
    expect(s.pendingQuestions).toEqual([])
  })
})

describe('read position', () => {
  it('the read position never moves backwards', () => {
    expect(markRead(markRead(s0(), 5), 2).lastReadSeq).toBe(5)
  })

})

describe('file conflict detection (FR-2 data loss)', () => {
  it('detects two sessions touching the same file', () => {
    const a = applyEvent(initialSession({ id: 'a', projectId: 'p1', name: 'a' }), ev({ type: 'files_touched', paths: ['src/x.ts', 'src/a.ts'] }), NOW)
    const b = applyEvent(initialSession({ id: 'b', projectId: 'p1', name: 'b' }), { ...ev({ type: 'files_touched', paths: ['src/x.ts'] }), sessionId: 'b' } as NormalizedEvent, NOW)
    expect(detectFileConflicts([a, b])).toEqual([{ path: 'src/x.ts', sessionIds: ['a', 'b'] }])
  })

})

/** The amount of thinking (#58) — the same lifetime as activity: it dies when the session leaves working */
describe('thinkingTokens', () => {
  it('the estimates add up and disappear when the turn ends', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const t1 = applyEvent(working, ev({ type: 'reasoning_delta', estTokens: 50 }), NOW)
    const t2 = applyEvent(t1, ev({ type: 'reasoning_delta', estTokens: 150 }), NOW)
    expect(t2.thinkingTokens).toBe(200)
    const done = applyEvent(t2, ev({ type: 'turn_complete' }), NOW)
    expect(done.thinkingTokens).toBeNull()
  })

  it('a chunk that carries only text (a codex summary) makes no number', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const s = applyEvent(working, ev({ type: 'reasoning_delta', text: '**Reviewing**' }), NOW)
    expect(s.thinkingTokens).toBeNull()
  })
})

/** The plan snapshot (#58, codex turn/plan/updated) — the same lifetime as activity */
describe('plan', () => {
  const steps = [
    { text: 'Set up', status: 'completed' as const },
    { text: 'Run', status: 'inProgress' as const },
  ]

  it('the snapshot is replaced, and disappears when the turn ends — left behind, the plan of a finished turn would lie', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const p1 = applyEvent(working, ev({ type: 'plan_update', steps: [steps[0]!] }), NOW)
    expect(p1.plan).toEqual([steps[0]])
    const p2 = applyEvent(p1, ev({ type: 'plan_update', steps }), NOW)
    expect(p2.plan).toEqual(steps) // A replacement, not deltas merged together
    const done = applyEvent(p2, ev({ type: 'turn_complete' }), NOW)
    expect(done.plan).toBeNull()
  })

  it('survives other events while working', () => {
    const working = replay([ev({ type: 'state_change', state: 'working' })])
    const p = applyEvent(working, ev({ type: 'plan_update', steps }), NOW)
    const after = applyEvent(p, ev({ type: 'message_delta', role: 'assistant', text: 'in progress' }), NOW)
    expect(after.plan).toEqual(steps)
  })
})
