import { describe, expect, it } from 'vitest'
import type { InboxItem } from '@cc/core'
import type { MailHeldRow, MailThreadRow } from '@cc/protocol/client'
import { arrangeInbox, cursorIndex, rowKeyOf } from './inboxList.js'

const party = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
const session = (id: string, waitingSince: number | null): InboxItem =>
  ({ id, projectId: 'p', name: id, state: 'waiting_input', waitingSince, lastSeq: 1, lastReadSeq: 0, unread: true, waitingMs: 0 })
const thread = (id: string, updatedAt: number, unread: number): MailThreadRow =>
  ({ id, subject: id, state: 'open', outcome: null, next: null, projectId: null, owner: party, assignee: null, unread, held: 0, blocked: 0, createdAt: 0, updatedAt, last: null })
const held = (messageId: string, since: number): MailHeldRow =>
  ({ messageId, threadId: 't', subject: messageId, sender: party, recipient: party, kind: 'task', reason: 'failed', preview: '', since })

describe('the inbox list (#2213)', () => {
  it('lists sessions and unread threads in one list, newest first', () => {
    const list = arrangeInbox([session('s-new', 900), session('s-old', 100)], { threads: [thread('m-mid', 500, 1)], held: [] })
    expect(list.waiting.map((r) => (r.kind === 'session' ? r.item.id : r.thread.id))).toEqual(['s-new', 'm-mid', 's-old'])
  })

  // The cursor walks the one list: mail between two sessions is a stop of its own
  it('the cursor keeps to its row as rows arrive above it, steps over mail rows, and stays at the place of a row that left', () => {
    const rows = arrangeInbox([session('a', 900), session('b', 100)], { threads: [thread('m', 500, 1)], held: [] }).waiting
    expect(rows.map(rowKeyOf)).toEqual(['a', 'mail:m', 'b'])
    expect(cursorIndex(rows, { key: 'mail:m', row: 1 })).toBe(1)
    // A wait that arrived on top: the cursor stays on the row it was on
    const arrived = arrangeInbox([session('new', 950), session('a', 900), session('b', 100)], { threads: [thread('m', 500, 1)], held: [] }).waiting
    expect(cursorIndex(arrived, { key: 'mail:m', row: 1 })).toBe(2)
    // The row left: the place it had, and the last row when that was the last
    expect(cursorIndex(rows, { key: 'gone', row: 1 })).toBe(1)
    expect(cursorIndex(rows, { key: 'gone', row: 7 })).toBe(2)
    expect(cursorIndex([], { key: null, row: 0 })).toBe(0)
  })

  it('a session with no start time has just arrived: first', () => {
    const list = arrangeInbox([session('proposal', null)], { threads: [thread('m', 500, 1)], held: [] })
    expect(list.waiting[0]).toMatchObject({ kind: 'session' })
  })

  it('folds a thread with nothing unread under Earlier, newest first', () => {
    const list = arrangeInbox([], { threads: [thread('old', 100, 0), thread('read', 300, 0), thread('new', 200, 2)], held: [] })
    expect(list.waiting.map((r) => (r.kind === 'mail' ? r.thread.id : ''))).toEqual(['new'])
    expect(list.earlier.map((t) => t.id)).toEqual(['read', 'old'])
  })

  it('pins mail that was not delivered apart from the list, the latest first', () => {
    const list = arrangeInbox([session('a', 900)], { threads: [], held: [held('h1', 100), held('h2', 800)] })
    expect(list.held.map((h) => h.messageId)).toEqual(['h2', 'h1'])
    expect(list.waiting).toHaveLength(1)
  })

  it('does not change what it is given', () => {
    const threads = [thread('b', 100, 0), thread('a', 200, 0)]
    arrangeInbox([], { threads, held: [] })
    expect(threads.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('with no mailbox yet, only the sessions', () => {
    expect(arrangeInbox([session('a', 1)], null)).toMatchObject({ held: [], earlier: [] })
  })
})
