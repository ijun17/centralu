/**
 * The version-1 `mail` tool mapped onto the message service (docs/plans/mailbox.md §11.3, M3a): a process started before the switch keeps its schema,
 * and every old action runs on the new tables. `reply` answers, `handled` is done, `read` reads a message and its chain, `send` sends; `update` and
 * `close` are gone with threads.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { oldThread } from './v61.test-helpers.js'

const A = at('a')
const B = at('b')
const C = at('c')
const W = at('w')
const ORC = at('orc')
let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const world = () => {
  const w = hostWorld()
  return { ...w, run: (id: string, args: Parameters<typeof w.tool.run>[1]) => w.tool.run(id, args) }
}

describe('send (§11.3: needsReply unless kind "note")', () => {
  it('sends a message that waits for a reply, says so, and names the receiver; to "orchestrator" goes to the role', () => {
    const w = world()
    const r = w.run('a', { action: 'send', to: 'b', text: 'Is #12 still open?' })
    expect(r.isError).toBeUndefined()
    const [sent] = w.store.mailbox.feedOf(A, { limit: 1 })
    expect(sent).toMatchObject({ kind: 'message', needsReply: true, body: 'Is #12 still open?' })
    expect(r.text).toBe(`Sent ${sent!.id} to beta (${B}). It waits for a reply; the reply will reach you as mail. What comes back arrives in your mailbox, and wakes you if you are at rest.`)
    w.run('a', { action: 'send', to: 'orchestrator', text: 'help please', kind: 'question' })
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(A, { limit: 1 })[0]!.id)[0]).toMatchObject({ recipient: ORC, via: 'orchestrator' })
  })

  it('kind "note" needs no reply; kind "assign" and "question" both need one', () => {
    const w = world()
    w.run('a', { action: 'send', to: 'b', text: 'fyi', kind: 'note' })
    w.run('a', { action: 'send', to: 'c', text: 'do this', kind: 'assign' })
    expect(w.store.mailbox.feedOf(A, { limit: 5 }).map((m) => [m.body, m.needsReply])).toEqual([['do this', true], ['fyi', false]])
  })

  it('"parent" is the session that started the caller; with none it is refused with S11', () => {
    const w = world()
    w.run('w', { action: 'send', to: 'parent', text: 'which branch?' })
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(W, { limit: 1 })[0]!.id)[0]!.recipient).toBe(A)
    expect(w.run('b', { action: 'send', to: 'parent', text: 'x' })).toEqual({
      text: 'Refused (unknown): this session was not started by another session; write to "orchestrator" or "person".',
      isError: true,
    })
  })

  it('from an untrusted project to another project it is held, and the answer says so', () => {
    const w = world()
    const r = w.run('x', { action: 'send', to: 'a', text: 'hello' })
    expect(r.text).toContain('Held: your project px is not trusted')
  })
})

describe('reply (§11.3: an answer, needsReply only with kind "question")', () => {
  it('answers the message `thread` names, to its sender, and settles the caller’s row on it', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'Is #12 still open?' })
    const r = w.run('b', { action: 'reply', thread: q.message.id, text: 'yes' })
    const [answer] = w.store.mailbox.feedOf(B, { limit: 1 })
    expect(answer).toMatchObject({ replyTo: q.message.id, needsReply: false })
    expect(w.store.mailbox.recipients(answer!.id)[0]!.recipient).toBe(A)
    expect(w.row(q.message.id, B)!.settled).toBe('answered')
    expect(r.text).toContain(`It answers ${q.message.id} from alpha.`)
    w.run('a', { action: 'reply', thread: answer!.id, text: 'and #13?', kind: 'question' })
    expect(w.store.mailbox.feedOf(A, { limit: 1 })[0]).toMatchObject({ needsReply: true })
  })

  it('a quiet answer says it reaches the receiver without waking it', () => {
    const w = world()
    const note = w.mail.send(A, { to: [B], text: 'fyi', needsReply: false })
    expect(w.run('b', { action: 'reply', thread: note.message.id, text: 'thanks' }).text).toContain('without waking it, at its next turn')
  })

  it('a legacy thread id names the newest message moved from that thread that the caller was sent', () => {
    const w = world()
    const message = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F07' }
    const thread = { id: 'hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F07' }
    oldThread(w.store, { id: thread.id, owner: A, subject: 'about #12', at: w.clock.t }, [{ id: message.id, sender: A, kind: 'question', body: 'still open?', receipts: [{ recipient: B }] }])
    w.store.movePendingThreadMail(w.clock.t, () => null)
    w.clock.t += 10
    w.run('b', { action: 'reply', thread: thread.id, text: 'yes' })
    expect(w.store.mailbox.feedOf(B, { limit: 1 })[0]).toMatchObject({ replyTo: message.id })
    // Its history reads from the old tables
    expect(w.run('b', { action: 'read', thread: message.id }).text).toContain('still open?')
  })

  it('an id that is not stored, or that the caller cannot read, is refused unknown_message; one’s own message is refused own_message', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'between us' })
    expect(w.run('c', { action: 'reply', thread: q.message.id, text: 'me too' }).text).toMatch(/^Refused \(unknown_message\)/)
    expect(w.run('a', { action: 'reply', thread: q.message.id, text: 'again' }).text).toMatch(/^Refused \(own_message\)/)
  })
})

describe('handled, read and inbox', () => {
  it('handled settles the caller’s row (done); on its own message it withdraws it; on one that needed nothing there is nothing to mark', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'q' })
    expect(w.run('b', { action: 'handled', thread: q.message.id }).text).toBe('1 message marked handled.')
    const q2 = w.mail.send(A, { to: [C], text: 'q2' })
    expect(w.run('a', { action: 'handled', thread: q2.message.id }).text).toBe(`Withdrawn: ${q2.message.id} no longer waits for an answer from 1 recipient.`)
    const note = w.mail.send(A, { to: [B], text: 'fyi', needsReply: false })
    expect(w.run('b', { action: 'handled', thread: note.message.id }).text).toBe('Nothing was waiting to be marked handled.')
  })

  it('read with no thread returns the unread mail quoted under Centralu’s header, and marks it read; with an id, the chain', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'line one\nline two' })
    const text = w.run('b', { action: 'read' }).text
    expect(text).toContain(`[${q.message.id}] message from a session of your project alpha (${A})`)
    expect(text).toContain('It needs a reply: not answered yet.')
    expect(text).toContain('> line one\n> line two')
    expect(w.row(q.message.id, B)!.readAt).not.toBeNull()
    w.mail.send(B, { to: [], replyTo: q.message.id, text: 'yes' })
    const answer = w.store.mailbox.feedOf(B, { limit: 1 })[0]!
    expect(w.run('a', { action: 'read', thread: answer.id }).text).toContain('Earlier in this chain:')
  })

  it('inbox lists what waits for the caller’s reply, what is unread, what it asked, and what it sent that is held', () => {
    const w = world()
    w.mail.send(A, { to: [B], text: 'q' })
    w.mail.send(B, { to: [C], text: 'mine' })
    const text = w.run('b', { action: 'inbox' }).text
    expect(text.split('\n')[0]).toBe('1 waiting for your reply, 0 unread, 1 of yours waiting for a reply, 0 held. Read with mail(action="read").')
    expect(world().run('c', { action: 'inbox' }).text).toBe('Your mailbox is empty.')
  })
})

describe('update and close are gone with threads (S9)', () => {
  it('are refused removed, naming the old tool’s calls', () => {
    const w = world()
    for (const action of ['update', 'close'] as const) {
      expect(w.run('a', { action, thread: 'hub-aaaaaaaa.t_01', state: 'review' })).toEqual({
        text: `Refused (removed): Centralu's mail has no threads any more, so "${action}" is gone. Answer a message with mail(action="reply", thread="<message id>", text="…"), and mark one that needs nothing with mail(action="handled", thread="<message id>").`,
        isError: true,
      })
    }
  })
})

void stops
