import { describe, expect, it } from 'vitest'
import { NormalizedEvent } from './events.js'
import { continuesStreamRow, endsStreamRow, keepsSubagentStep, recordedRowKind, streamRowKind, subagentStepRow } from './transcript-rows.js'

const delta = (text: string, messageId?: string): NormalizedEvent => ({ type: 'message_delta', sessionId: 's', role: 'assistant', text, ...(messageId ? { messageId } : {}) })

describe('transcript rows', () => {
  it('a chunk grows the open row of its kind unless it names another message (#77, #212)', () => {
    const open = { kind: 'text' as const, payload: delta('a', 'm1') }
    expect(continuesStreamRow(open, delta('b', 'm1'))).toBe(true)
    expect(continuesStreamRow(open, delta('b'))).toBe(true)
    expect(continuesStreamRow(open, delta('b', 'm2'))).toBe(false)
    expect(continuesStreamRow({ kind: 'text', payload: delta('a') }, delta('b', 'm2'))).toBe(true)
    expect(continuesStreamRow({ kind: 'reasoning', payload: {} }, delta('b'))).toBe(false)
    expect(continuesStreamRow(undefined, delta('b'))).toBe(false)
  })

  it('a reasoning chunk with no text is not a recorded chunk (#58)', () => {
    expect(streamRowKind({ type: 'reasoning_delta', sessionId: 's', estTokens: 10 })).toBeNull()
    expect(streamRowKind({ type: 'reasoning_delta', sessionId: 's', text: 'x' })).toBe('reasoning')
  })

  it('an error is a marker row and ends the open message (#107)', () => {
    const error: NormalizedEvent = { type: 'error', sessionId: 's', error: { code: 'internal', message: 'x', retryable: false } }
    expect(recordedRowKind(error)).toBe('marker')
    expect(endsStreamRow(error)).toBe(true)
    expect(endsStreamRow({ type: 'state_change', sessionId: 's', state: 'working' })).toBe(false)
    expect(endsStreamRow({ type: 'turn_complete', sessionId: 's' })).toBe(true)
    // An agent's image is a row of its own between the text around it (#868)
    expect(endsStreamRow({ type: 'message_image', sessionId: 's', mime: 'image/png', data: '' })).toBe(true)
    // …and its event keeps the row's number through the wire schema, which drops a key it does not know
    expect(NormalizedEvent.parse({ type: 'message_image', sessionId: 's', mime: 'image/png', data: '', seq: 7 })).toMatchObject({ seq: 7 })
  })

  it('a subagent step keeps its kind and role, and a chunk with no text is dropped (#222)', () => {
    expect(subagentStepRow({ type: 'message_delta', sessionId: 's', role: 'assistant', text: 'x' })).toEqual({ kind: 'text', role: 'assistant' })
    expect(keepsSubagentStep({ type: 'message_delta', sessionId: 's', role: 'assistant', text: '' })).toBe(false)
  })
})
