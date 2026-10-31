/**
 * The catch-up at a wake after a restart, over the real manager and the Claude reader: a mail wake that was accepted and whose
 * answer the host did not record is in the CLI's record, and what the catch-up stores of it must not read as the person's
 * message (docs/plans/mailbox.md §9.2). The record is `getSessionMessages` as the SDK returns it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, HistoryMessage } from '../adapters/contract.js'
import { __setSessionApiForTest, readClaudeHistory } from '../adapters/claude/history.js'
import { buildMailFrame } from '../mail/frame.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FakeAdapter, managerWorld } from './manager.test-helpers.js'

class ReadingAdapter extends FakeAdapter {
  override readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  async listExternalSessions() {
    return [{ externalId: 'ext-1', title: 'Work', updatedAt: 100 }]
  }
  async readExternalHistory(externalId: string, cwd: string, limit: number): Promise<HistoryMessage[]> {
    return readClaudeHistory(externalId, cwd, limit)
  }
}

let store: ReturnType<typeof managerWorld>['store']
let events: NormalizedEvent[]

beforeEach(() => {
  ;({ store, events } = managerWorld())
})
afterEach(() => __setSessionApiForTest(undefined))

const WAKE = buildMailFrame([
  {
    messageId: 'hub-aaaaaaaa.m_01J00000000000000000000001',
    threadId: 'hub-aaaaaaaa.t_01J00000000000000000000001',
    kind: 'note',
    from: 'person',
    relation: 'the person',
    inline: 'Fourth message',
  },
]).text

describe('the catch-up after a restart with a mail wake in the CLI’s record', () => {
  it('stores no user row for the wake, and the answer after it', async () => {
    __setSessionApiForTest({
      listSessions: async () => [],
      getSessionMessages: async () => [
        { type: 'user', message: { content: WAKE } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Answered by mail' }] } },
      ],
    })
    const a = new ReadingAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const first = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(first, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await first.disposeAll() // The host went down: the record exists, the process does not

    const second = new SessionManager(store, adapters, (e) => events.push(e))
    await createRpcHandler(second, adapters)('agents.send', { sessionId: s.id, text: 'continue' })

    const rows = (await createRpcHandler(second, adapters)('messages.load', { sessionId: s.id, limit: 100 })) as { role: string; payload: { text?: string } }[]
    const text = rows.filter((r) => r.payload.text !== undefined).map((r) => [r.role, r.payload.text])
    expect(text).toContainEqual(['assistant', 'Answered by mail'])
    expect(JSON.stringify(rows)).not.toContain('Fourth message')
    expect(rows.some((r) => r.role === 'user' && r.payload.text !== 'continue')).toBe(false)
  })
})
