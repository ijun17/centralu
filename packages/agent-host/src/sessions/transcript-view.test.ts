import { describe, expect, it } from 'vitest'
import type { SessionInfo, StoredMessage } from '@cc/protocol'
import { contextAt, labelOf, lastActiveOf, orchestratorMemory, previewOf, timeOf, type MessageReader } from './transcript-view.js'

/** A reader over an in-memory transcript, with the store's paging rules (newest `limit` before a seq, or the next `limit` after one). */
function readerOf(rows: Omit<StoredMessage, 'sessionId' | 'seq'>[], sessionId = 's1'): MessageReader {
  const all: StoredMessage[] = rows.map((r, i) => ({ ...r, sessionId, seq: i + 1 }))
  return {
    loadMessages: (id, limit = 200, beforeSeq) =>
      all.filter((m) => m.sessionId === id && (beforeSeq === undefined || m.seq < beforeSeq)).slice(-limit),
    loadMessagesFrom: (id, afterSeq, limit = 20) => all.filter((m) => m.sessionId === id && m.seq > afterSeq).slice(0, limit),
  }
}

const TS = Date.UTC(2026, 0, 2, 3, 4, 5)
const text = (role: StoredMessage['role'], t: string, extra: Record<string, unknown> = {}) => ({
  role, kind: 'text' as const, payload: { text: t, ...extra }, ts: TS,
})
const session = (name: string) => ({ id: 's1', name }) as SessionInfo

describe('labelOf', () => {
  it('keeps an ordinary name as it is', () => {
    expect(labelOf(readerOf([]), session('Fix the login bug'))).toBe('Fix the login bug')
  })

  it('names a continued session after its first real instruction, skipping the compaction summary', () => {
    const reader = readerOf([
      text('user', 'This session is being continued from a previous conversation...'),
      text('user', `Make   the build ${'x'.repeat(80)}`),
    ])
    const label = labelOf(reader, session('This session is being continued from a previous conversation'))
    expect(label).toBe(`Make the build ${'x'.repeat(45)}… (resumed session)`)
  })

  it('falls back to a shortened name when a continued session has no instruction', () => {
    const name = 'This session is being continued from a previous conversation'
    expect(labelOf(readerOf([]), session(name))).toBe(`${name.slice(0, 40)}…`)
  })
})

describe('previewOf', () => {
  it('joins the last response and cuts it at 120 characters by default', () => {
    const reader = readerOf([text('user', 'q'), text('assistant', 'a'.repeat(100)), text('assistant', 'b'.repeat(100))])
    expect(previewOf(reader, 's1')).toBe(`${'a'.repeat(100)}${'b'.repeat(20)}…`)
  })

  it('skips tool calls after the last response', () => {
    const reader = readerOf([
      text('assistant', 'Done.'),
      { role: 'assistant', kind: 'tool_call', payload: { summary: { title: 'Run tests' } }, ts: TS },
    ])
    expect(previewOf(reader, 's1')).toBe('Done.')
  })

  it("falls back to a tool call's title when there is no response yet", () => {
    const reader = readerOf([text('user', 'go'), { role: 'system', kind: 'tool_call', payload: { summary: { title: 'Run tests' } }, ts: TS }])
    expect(previewOf(reader, 's1')).toBe('Run tests')
  })
})

describe('orchestratorMemory', () => {
  it('hands over only the person and its own answers, with a header', () => {
    const reader = readerOf([
      text('user', 'Look at the Alpha project status'),
      text('assistant', 'Alpha has two tests failing.'),
      text('user', 'HOSTILE_FROM', { from: { sessionId: 'w', name: 'worker' } }),
      { role: 'system', kind: 'tool_result', payload: { text: 'TOOL_BODY' }, ts: TS },
    ])
    const memory = orchestratorMemory(reader, 's1')
    expect(memory).toContain('# Past conversation (before this process started)')
    expect(memory).toContain('Person: Look at the Alpha project status')
    expect(memory).toContain('Me: Alpha has two tests failing.')
    expect(memory).not.toContain('HOSTILE_FROM')
    expect(memory).not.toContain('TOOL_BODY')
  })

  it('is empty when there is nothing to hand over', () => {
    expect(orchestratorMemory(readerOf([]), 's1')).toBe('')
  })

  it('cuts each line at 600 characters', () => {
    const memory = orchestratorMemory(readerOf([text('assistant', 'z'.repeat(700))]), 's1')
    expect(memory).toContain(`Me: ${'z'.repeat(600)}`)
    expect(memory).not.toContain('z'.repeat(601))
  })
})

describe('contextAt', () => {
  it('restores the text around a spot in order, marking what the person said', () => {
    const reader = readerOf([text('assistant', 'before'), text('user', 'hit'), text('assistant', 'after')])
    expect(contextAt(reader, 's1', 2)).toBe('before\n[person] hit\nafter')
  })
})

describe('timestamps', () => {
  it('formats the last activity and the time of a spot to the minute', () => {
    const reader = readerOf([text('user', 'one'), text('assistant', 'two')])
    expect(lastActiveOf(reader, 's1')).toBe('2026-01-02 03:04')
    expect(timeOf(reader, 's1', 1)).toBe('2026-01-02 03:04')
    expect(lastActiveOf(readerOf([]), 's1')).toBeUndefined()
  })
})
