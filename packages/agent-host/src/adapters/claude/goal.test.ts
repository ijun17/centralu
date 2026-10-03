/**
 * A Claude session's /goal, read off the stream (2026-10-03). The fixtures are the shapes measured
 * through `query()` with streaming input and the installed CLI 2.1.282 (SDK 0.3.263, haiku, a temp
 * git folder) — see `ClaudeGoalTracker` for the full table.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { ClaudeStreamNormalizer } from './normalize.js'

const SID = 's1'
const COND = 'the file counter.txt contains the number 3'

/** The CLI's own reply to a /goal command: an assistant message with no stream deltas behind it. */
const synthetic = (text: string, id = 'f2c1e0aa-0000-4000-8000-000000000001') => ({
  type: 'assistant',
  message: { id, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
})
/** One model call: message_start, one text delta, then its finished message. */
const modelSays = (id: string, text: string) => [
  { type: 'stream_event', event: { type: 'message_start', message: { id } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
  { type: 'assistant', message: { id, model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text }] } },
]
const stopFeedback = (cond: string, reason: string) => ({
  type: 'user',
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n[${cond}]: ${reason}` }] },
})
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, ...extra })

const goals = (events: NormalizedEvent[]) =>
  events.filter((e): e is Extract<NormalizedEvent, { type: 'goal' }> => e.type === 'goal').map((e) => e.goal)
const pushAll = (stream: ClaudeStreamNormalizer, msgs: unknown[]) => msgs.flatMap((m) => stream.push(m))

describe('claude /goal — the badge from what the CLI says', () => {
  it('set, not met at Stop (the CLI keeps the turn going), then met: active → one lap with its reason → cleared at the one result', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    const set = stream.push(synthetic(`Goal set: ${COND}`))
    expect(goals(set)).toEqual([{ objective: COND, status: 'active' }])
    // The CLI's words still reach the conversation
    expect(set).toContainEqual(expect.objectContaining({ type: 'message_delta', text: `Goal set: ${COND}` }))

    const lap = pushAll(stream, [...modelSays('msg_1', 'Counter incremented from 0 to 1.'), stopFeedback(COND, 'It contains 1, not 3.')])
    expect(goals(lap)).toEqual([{ objective: COND, status: 'active', iterations: 1, reason: 'It contains 1, not 3.' }])
    // Not a turn end: the hook sent the model back to work inside the same turn
    expect(lap.some((e) => e.type === 'turn_complete')).toBe(false)

    const end = pushAll(stream, [...modelSays('msg_2', 'Counter incremented from 2 to 3.'), result()])
    expect(goals(end)).toEqual([null])
    expect(end.filter((e) => e.type === 'turn_complete')).toHaveLength(1)
  })

  it('reads the status and clear replies — iterations and the last check from "Goal active", none from "No goal set" and "Goal cleared"', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    const active = stream.push(synthetic(`Goal active: ${COND} (2 turns)\nLast check: It contains 2, not 3.`))
    expect(goals(active)).toEqual([{ objective: COND, status: 'active', iterations: 2, reason: 'It contains 2, not 3.' }])
    // A status reply is a result with no model call — it must not read as "met"
    expect(goals(stream.push(result({ num_turns: 0 })))).toEqual([])

    stream.goal.commandSent()
    expect(goals(stream.push(synthetic(`Goal cleared: ${COND}`)))).toEqual([null])

    stream.goal.commandSent()
    expect(goals(stream.push(synthetic(`Goal active: ${COND} (not yet evaluated)`)))).toEqual([{ objective: COND, status: 'active' }])
    stream.goal.commandSent()
    expect(goals(stream.push(synthetic('No goal set. Usage: `/goal <condition>`')))).toEqual([null])
  })

  it('reads a reply only while a /goal we passed through is waiting — the same words from anywhere else change nothing', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    expect(goals(stream.push(synthetic(`Goal set: ${COND}`)))).toEqual([])
    // A refusal answers the command without setting anything, and uses up the wait
    stream.goal.commandSent()
    expect(goals(stream.push(synthetic('/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.')))).toEqual([])
    expect(goals(stream.push(synthetic(`Goal set: ${COND}`)))).toEqual([])
  })

  it('Stop hook feedback counts only when its bracket holds the goal — a person\'s own prompt Stop hook has the same shape', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    stream.push(synthetic(`Goal set: ${COND}`))
    expect(goals(stream.push(stopFeedback('Every test passes', 'Two fail.')))).toEqual([])
  })

  it('an interrupted goal turn ends in success too, and the goal stays (measured: "Goal active" afterwards)', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    stream.push(synthetic(`Goal set: ${COND}`))
    pushAll(stream, modelSays('msg_1', 'Counter incremented from 0 to 1.'))
    stream.stopped()
    const end = pushAll(stream, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      result(),
    ])
    expect(goals(end)).toEqual([])
  })

  it('a resumed process knows the goal the host handed it, and clears it when the goal is met', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.seed({ objective: COND, status: 'active', iterations: 2 })
    expect(goals(pushAll(stream, [stopFeedback(COND, 'Still 2.')]))).toEqual([
      { objective: COND, status: 'active', iterations: 3, reason: 'Still 2.' },
    ])
    expect(goals(pushAll(stream, [...modelSays('msg_9', 'Done.'), result()]))).toEqual([null])
  })

  it('once the CLI announces the goal itself (active_goal), its word is the only one', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    const announced = stream.push({ type: 'active_goal', value: { condition: COND, iterations: 0, set_at: 1, tokens_at_start: 0 } })
    expect(goals(announced)).toEqual([{ objective: COND, status: 'active', iterations: 0 }])
    expect(goals(stream.push(synthetic(`Goal set: ${COND}`)))).toEqual([])
    expect(goals(pushAll(stream, [...modelSays('msg_1', 'Done.'), result()]))).toEqual([])
  })

  it('the CLI\'s "Goal set" and the model\'s words are two messages, not one row (#212)', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.goal.commandSent()
    const events = pushAll(stream, [synthetic(`Goal set: ${COND}`, 'local-1'), ...modelSays('msg_1', 'Understood.'), ...modelSays('msg_2', 'Still going.')])
    const ids = events.flatMap((e) => (e.type === 'message_delta' ? [e.messageId] : []))
    expect(ids).toEqual(['local-1', 'msg_1', 'msg_2'])
  })
})
