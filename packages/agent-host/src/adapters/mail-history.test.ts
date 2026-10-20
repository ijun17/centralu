import { afterEach, describe, expect, it } from 'vitest'
import { mailFrame, type MailFrameItem } from '../mail/frame.js'
import { __setSessionApiForTest, readClaudeHistory } from './claude/history.js'
import { turnsToHistory } from './codex/history.js'

/**
 * A mail wake is the CLI's input, so the tool's record holds it as a user turn (docs/plans/mailbox.md §9.2). Read back after a
 * restart it must not come out as the person's words: the host writes no user row for a delivery, and `read_session` and `recall`
 * would say the person wrote what a session did.
 */

afterEach(() => __setSessionApiForTest(undefined))

const T1 = 'hub-aaaaaaaa.t_01J00000000000000000000001'
const M = (n: number) => `hub-aaaaaaaa.m_01J${String(n).padStart(23, '0')}`
const item = (n: number, over: Partial<MailFrameItem> = {}): MailFrameItem => ({ messageId: M(n), threadId: T1, kind: 'note', from: 'person', relation: 'the person', inline: 'Fourth message', ...over })

const FROM_PERSON = mailFrame([item(1)])
const FROM_SESSION = mailFrame([item(2, { from: 'session:hub-aaaaaaaa/s2', relation: 'the session that gave you this work', kind: 'assign', inline: 'Do the thing\nand report' })])

describe('a mail wake read back from the record', () => {
  it('Claude: is not the person’s message, and what is around it stays', async () => {
    __setSessionApiForTest({
      listSessions: async () => [],
      getSessionMessages: async () => [
        { type: 'user', message: { content: 'Fix the build' } },
        { type: 'user', message: { content: FROM_PERSON } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Answered by mail' }] } },
        { type: 'user', message: { content: [{ type: 'text', text: FROM_SESSION }] } },
        { type: 'user', message: { content: 'A real message' } },
      ],
    })
    expect(await readClaudeHistory('s', '/p', 100)).toEqual([
      { role: 'user', text: 'Fix the build' },
      { role: 'assistant', text: 'Answered by mail' },
      { role: 'user', text: 'A real message' },
    ])
  })

  it('Codex: is not the person’s message, and what is around it stays', () => {
    const out = turnsToHistory(
      [
        { startedAt: 1, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the build' }] }, { type: 'agentMessage', text: 'Done' }] },
        { startedAt: 2, items: [{ type: 'userMessage', content: [{ type: 'text', text: FROM_PERSON }] }, { type: 'agentMessage', text: 'Answered by mail' }] },
        { startedAt: 3, items: [{ type: 'userMessage', content: [{ type: 'text', text: FROM_SESSION }] }] },
      ],
      100,
    )
    expect(out.map((h) => (h.role === 'system' ? h.event.type : [h.role, h.text]))).toEqual([
      ['user', 'Fix the build'],
      ['assistant', 'Done'],
      ['assistant', 'Answered by mail'],
    ])
  })
})
