import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * An answered choice goes back as the SDK's own answer, not as a denial (2026-09-30).
 *
 * The answer to an AskUserQuestion card used to travel as a deny's message. The model read it, but the CLI marks a
 * denied tool's result as an error, so every answered card read "Failed". It now goes back as an allow with
 * `updatedInput.answers` (question text → chosen labels, joined with ", "). Measured against the real CLI the same
 * day, that finishes the tool with `is_error: false` and the model gets the answer. A choice closed without an
 * answer is still a deny, because that one did fail.
 *
 * The SDK is swapped for a fake, and the callback the adapter passed is called directly.
 */
type Decision = { behavior: string; message?: string; updatedInput?: Record<string, unknown> }
type CanUseTool = (name: string, input: Record<string, unknown>, opts?: { toolUseID?: string; signal?: AbortSignal }) => Promise<Decision>
const sdk = vi.hoisted(() => ({ options: null as null | { canUseTool?: CanUseTool } }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool } }) => {
    sdk.options = options
    return {
      // eslint-disable-next-line require-yield -- a stream where the CLI says nothing; this test only calls the callback
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

const QUESTIONS = {
  questions: [
    { question: 'Pick one', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    { question: 'Pick any', header: 'Any', multiSelect: true, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] },
  ],
}

const askedIn = (events: NormalizedEvent[]) =>
  (events.find((e) => e.type === 'question_request') as Extract<NormalizedEvent, { type: 'question_request' }>).requestId

describe('answering an AskUserQuestion card', () => {
  it('goes back as an allow whose updatedInput carries the answers, keyed by question, several joined with ", "', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'qa1', cwd: '/x', permissionPreset: 'normal' }, (e) => events.push(e))

    const decision = sdk.options!.canUseTool!('AskUserQuestion', QUESTIONS, { toolUseID: 'toolu_q1' })
    const answered = handle.answerQuestion!(askedIn(events), [
      { question: 'Pick one', answers: ['A'] },
      { question: 'Pick any', answers: ['X', 'Y'] },
    ])
    expect(answered).toBe(true)

    const r = await decision
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ ...QUESTIONS, answers: { 'Pick one': 'A', 'Pick any': 'X, Y' } })
    expect(events.some((e) => e.type === 'question_resolved')).toBe(true)
    await handle.dispose()
  })

  it('a card closed without an answer is still a deny', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'qa2', cwd: '/x', permissionPreset: 'normal' }, (e) => events.push(e))

    const decision = sdk.options!.canUseTool!('AskUserQuestion', QUESTIONS, { toolUseID: 'toolu_q2' })
    handle.interrupt()
    const r = await decision
    expect(r.behavior).toBe('deny')
    expect(r.updatedInput).toBeUndefined()
    await handle.dispose()
  })
})

/**
 * A card the CLI withdraws closes. The SDK aborts the callback's `signal` when the CLI cancels a permission request
 * itself (the tool was aborted, or the turn ended without our Stop). The adapter ignored it, so the card stayed open
 * forever and an answer resolved a promise nobody was waiting on.
 */
describe('a card the CLI withdraws', () => {
  it('an approval card closes as denied when its request is cancelled, and a late answer reaches nothing', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'qa3', cwd: '/x', permissionPreset: 'normal' }, (e) => events.push(e))
    const cancel = new AbortController()

    const decision = sdk.options!.canUseTool!('Bash', { command: 'rm -rf build' }, { toolUseID: 'toolu_b1', signal: cancel.signal })
    const asked = events.find((e) => e.type === 'approval_request') as Extract<NormalizedEvent, { type: 'approval_request' }>
    cancel.abort()

    expect(events.filter((e) => e.type === 'approval_resolved')).toEqual([
      { type: 'approval_resolved', sessionId: 'qa3', requestId: asked.requestId, decision: 'deny' },
    ])
    expect((await decision).behavior).toBe('deny')
    expect(handle.respondApproval(asked.requestId, 'allow')).toBe(false)
    await handle.dispose()
  })

  it('a question card closes when its request is cancelled, and a late answer reaches nothing', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'qa4', cwd: '/x', permissionPreset: 'normal' }, (e) => events.push(e))
    const cancel = new AbortController()

    const decision = sdk.options!.canUseTool!('AskUserQuestion', QUESTIONS, { toolUseID: 'toolu_q4', signal: cancel.signal })
    const id = askedIn(events)
    cancel.abort()

    expect(events.filter((e) => e.type === 'question_resolved')).toEqual([{ type: 'question_resolved', sessionId: 'qa4', requestId: id }])
    expect((await decision).behavior).toBe('deny')
    expect(handle.answerQuestion!(id, [{ question: 'Pick one', answers: ['A'] }])).toBe(false)
    await handle.dispose()
  })

  it('a card already answered stays answered when the signal fires afterwards', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'qa5', cwd: '/x', permissionPreset: 'normal' }, (e) => events.push(e))
    const cancel = new AbortController()

    const decision = sdk.options!.canUseTool!('Bash', { command: 'ls' }, { toolUseID: 'toolu_b5', signal: cancel.signal })
    const asked = events.find((e) => e.type === 'approval_request') as Extract<NormalizedEvent, { type: 'approval_request' }>
    handle.respondApproval(asked.requestId, 'allow')
    cancel.abort()

    expect((await decision).behavior).toBe('allow')
    expect(events.filter((e) => e.type === 'approval_resolved')).toHaveLength(1)
    await handle.dispose()
  })
})
