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
type CanUseTool = (name: string, input: Record<string, unknown>, opts?: { toolUseID?: string }) => Promise<Decision>
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
