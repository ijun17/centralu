import { describe, expect, it } from 'vitest'
import type { InboxItem } from '@cc/core'
import type { MailHeldRow, MailThreadRow } from '@cc/protocol/client'
import { arrangeInbox, CURSOR_START, rowKeyOf, settleCursor } from './inboxList.js'

const party = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
const session = (id: string, waitingSince: number | null): InboxItem =>
  ({ id, projectId: 'p', name: id, state: 'waiting_input', waitingSince, lastSeq: 1, lastReadSeq: 0, unread: true, waitingMs: 0 })
const thread = (id: string, updatedAt: number, unread: number): MailThreadRow =>
  ({ id, subject: id, state: 'open', outcome: null, next: null, projectId: null, owner: party, assignee: null, unread, held: 0, blocked: 0, ask: null, createdAt: 0, updatedAt, last: null })
const held = (messageId: string, since: number): MailHeldRow =>
  ({ messageId, threadId: 't', subject: messageId, sender: party, recipient: party, kind: 'task', reason: 'failed', preview: '', since })

describe('the inbox list (#2213)', () => {
  it('lists sessions and unread threads in one list, newest first', () => {
    const list = arrangeInbox([session('s-new', 900), session('s-old', 100)], { threads: [thread('m-mid', 500, 1)], held: [] })
    expect(list.waiting.map((r) => (r.kind === 'session' ? r.item.id : r.thread.id))).toEqual(['s-new', 'm-mid', 's-old'])
  })

  it('puts the threads that wait on the person’s answer first, newest first, above the rows (#2229), and keeps them in the cursor’s one list', () => {
    const asking = (id: string, updatedAt: number): MailThreadRow => ({ ...thread(id, updatedAt, 1), ask: { id: `${id}-q`, sender: party, text: 'Which?', open: [`${id}-q`] } })
    const list = arrangeInbox([session('s-new', 900)], { threads: [thread('m-row', 800, 1), asking('q-old', 100), asking('q-new', 500)], held: [] })
    expect(list.waiting.map(rowKeyOf)).toEqual(['mail:q-new', 'mail:q-old', 's-new', 'mail:m-row'])
  })

  // The cursor walks the one list: mail between two sessions is a stop of its own
  it('the cursor opens on the top row, steps over mail rows, and a closed list resets it', () => {
    const rows = arrangeInbox([session('a', 900), session('b', 100)], { threads: [thread('m', 500, 1)], held: [] }).waiting
    expect(rows.map(rowKeyOf)).toEqual(['a', 'mail:m', 'b'])
    expect(settleCursor(rows, CURSOR_START, true)).toEqual({ key: 'a', row: 0 })
    const onMail = { key: 'mail:m', row: 1 }
    expect(settleCursor(rows, onMail, true)).toBe(onMail)
    expect(settleCursor(rows, onMail, false)).toBe(CURSOR_START)
    expect(settleCursor([], onMail, true)).toBe(CURSOR_START)
  })

  // The stale row number the review found: a row arrives above the cursor, then the cursor's own row is done
  it('the cursor follows its row as rows arrive above it, and a row that is done hands it to the row now at its place', () => {
    const at = (rows: ReturnType<typeof arrangeInbox>['waiting'], cursor: { key: string | null; row: number }) => settleCursor(rows, cursor, true)
    const list = (...ids: [string, number][]) => arrangeInbox(ids.map(([id, t]) => session(id, t)), null).waiting
    let cursor = at(list(['k', 500], ['y', 100]), CURSOR_START)
    expect(cursor).toEqual({ key: 'k', row: 0 })
    // A wait arrived on top: K is row 1 now, and the cursor's place is kept up to date, not left at 0
    cursor = at(list(['x', 900], ['k', 500], ['y', 100]), cursor)
    expect(cursor).toEqual({ key: 'k', row: 1 })
    // K is done: the row at K's place (Y), not the new top row
    cursor = at(list(['x', 900], ['y', 100]), cursor)
    expect(cursor).toEqual({ key: 'y', row: 1 })
    // K came back: the cursor does not jump to it
    expect(at(list(['x', 900], ['k', 500], ['y', 100]), cursor)).toEqual({ key: 'y', row: 2 })
    // The last row done: the cursor is kept on the last row
    expect(at(list(['x', 900]), { key: 'y', row: 1 })).toEqual({ key: 'x', row: 0 })
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

  it('a question read but not answered still waits: a card above the rows, never under Earlier; answered and read, it folds (#2233)', () => {
    const asking = (id: string, unread: number): MailThreadRow => ({ ...thread(id, 100, unread), ask: { id: `${id}-q`, sender: party, text: 'Which?', open: [`${id}-q`] } })
    const list = arrangeInbox([], { threads: [asking('read-asked', 0), thread('row', 500, 1), thread('read', 300, 0)], held: [] })
    expect(list.waiting.map(rowKeyOf)).toEqual(['mail:read-asked', 'mail:row'])
    expect(list.earlier.map((t) => t.id)).toEqual(['read'])
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
