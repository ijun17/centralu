/**
 * The version-1 `mail` tool mapped onto the message service (docs/plans/mailbox.md §11.3, M3a): a process started before the switch keeps its schema,
 * and every old action runs on the new tables. `reply` answers, `handled` is done, `read` reads a message and its chain, `send` sends; `update` and
 * `close` are gone with threads.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { HOST, at, hostWorld } from './host-mail.test-helpers.js'
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

  // #1984: a child told to write to its parent mailed the orchestrator, the one role it could see
  it('a session with a parent that mails "orchestrator" is told once that it went there, not to the parent; the mail is not rerouted', () => {
    const w = world()
    const first = w.run('w', { action: 'send', to: 'orchestrator', text: 'checkpoint 1' })
    expect(first.text).toContain('It went to the orchestrator, not to your parent "alpha". If you meant your parent, use to: "parent".')
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(W, { limit: 1 })[0]!.id)[0]).toMatchObject({ recipient: ORC, via: 'orchestrator' })
    expect(w.run('w', { action: 'send', to: 'orchestrator', text: 'checkpoint 2' }).text).not.toContain('not to your parent')
    // To the parent, or from a session with none, there is nothing to say
    expect(w.run('w', { action: 'send', to: 'parent', text: 'which branch?' }).text).not.toContain('not to your parent')
    expect(world().run('b', { action: 'send', to: 'orchestrator', text: 'help' }).text).not.toContain('not to your parent')
    // A child the orchestrator started has it for its parent: nothing to correct
    expect(world().run('o', { action: 'send', to: 'orchestrator', text: 'done' }).text).not.toContain('not to your parent')
  })

  // #1987: a child started from a linked computer has no parent here; "person" would stay unseen on this computer
  it('"parent" of a session started from a linked computer says the parent is elsewhere and unreachable, and does not point at "person"', () => {
    const w = world()
    const r = w.tool.run('b', { action: 'send', to: 'parent', text: 'blocked' })
    expect(r.text).not.toContain('another computer')
    const hub = hostWorld({ fromHub: ['b'] })
    stops.push(() => hub.stop())
    const refused = hub.tool.run('b', { action: 'send', to: 'parent', text: 'blocked' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe('Refused (unknown): your parent is a session on another computer, and mail does not reach it from here yet. End your turn with the answer: that is how your parent hears from you.')
    expect(refused.text).not.toContain('person')
  })

  it('from an untrusted project to another project it is held, and the answer says so', () => {
    const w = world()
    const r = w.run('x', { action: 'send', to: 'a', text: 'hello' })
    expect(r.text).toContain('Held: your project px is not trusted')
  })
})

describe('"to" as a name (#2039)', () => {
  const sentTo = (w: ReturnType<typeof world>, from: string) => w.store.mailbox.recipients(w.store.mailbox.feedOf(at(from), { limit: 1 })[0]!.id)[0]!.recipient
  const TEXT = 'a session in the archive or deleted cannot be written to). Write to a session by its exact name, its id or session:<host>/<id>. Mail does not reach sessions on other computers yet.'

  it("a session's name, in any case, reaches it as its id does; so does the address with the name in it", () => {
    const w = world()
    for (const to of ['beta', 'Beta', ' BETA ', 'b', B, `session:${HOST}/Beta`]) {
      expect(w.run('a', { action: 'send', to, text: `hi ${to}` }).isError).toBeUndefined()
      expect(sentTo(w, 'a')).toBe(B)
    }
  })

  it('a name no session has is refused as unknown, saying what an address looks like, never as gone', () => {
    const w = world()
    expect(w.run('a', { action: 'send', to: 'nobody', text: 'x' })).toEqual({
      text: `Refused (unknown): no session on this computer has the id or name "nobody" (${TEXT}`,
      isError: true,
    })
    // The expanded form of a name, and a name with a space or a colon in it (which no address holds)
    expect(w.run('a', { action: 'send', to: `session:${HOST}/nobody`, text: 'x' }).text).toContain('Refused (unknown): no session on this computer has the id or name "nobody"')
    expect(w.run('a', { action: 'send', to: 'fix: the mail', text: 'x' }).text).toContain('Refused (unknown): no session on this computer has the id or name "fix: the mail"')
    // An address on another computer is not looked up here: the service refuses it in its own words
    expect(w.run('a', { action: 'send', to: 'session:hub-bbbbbbbb/z', text: 'x' }).text).toBe('Refused (elsewhere): session:hub-bbbbbbbb/z is on another computer, and mail does not reach other computers yet: the session that started it there reaches it with agent_session send.')
  })

  it('a name two sessions share is refused with both addresses, and an address or an id still reaches exactly one', () => {
    const w = hostWorld({ extra: { d: { name: 'Beta', projectId: 'p2' } } })
    stops.push(() => w.stop())
    const r = w.tool.run('a', { action: 'send', to: 'beta', text: 'x' })
    expect(r).toEqual({ text: `Refused (ambiguous): 2 sessions are named "beta": ${B} (project p1, idle), ${at('d')} (project p2, idle). Send to one of them by its address.`, isError: true })
    expect(w.tool.run('a', { action: 'send', to: `session:${HOST}/Beta`, text: 'x' }).text).toContain('Refused (ambiguous)')
    expect(w.tool.run('a', { action: 'send', to: at('d'), text: 'x' }).isError).toBeUndefined()
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(A, { limit: 1 })[0]!.id)[0]!.recipient).toBe(at('d'))
  })

  it('the caller is never a candidate: an heir with the name of the session it replaced writes to that one; "Person" is the person', () => {
    const w = hostWorld({ extra: { d: { name: 'Alpha', projectId: 'p1' } } })
    stops.push(() => w.stop())
    expect(w.tool.run('d', { action: 'send', to: 'alpha', text: 'x' }).isError).toBeUndefined()
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(at('d'), { limit: 1 })[0]!.id)[0]!.recipient).toBe(A)
    expect(w.tool.run('a', { action: 'send', to: 'Person', text: 'x' }).isError).toBeUndefined()
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(A, { limit: 1 })[0]!.id)[0]!.recipient).toBe(PERSON)
  })

  // The child's host has no row of its parent, which lives on the hub: no name or address it can write names it, and the refusal says why instead of "gone"
  it('a child started from a linked computer that writes the name of its parent, or that name expanded against its own host, is told mail does not reach it', () => {
    const child = hostWorld({ fromHub: ['b'] })
    stops.push(() => child.stop())
    for (const to of ['Hub Parent', 'hubparent', `session:${HOST}/hubparent`]) {
      const r = child.tool.run('b', { action: 'send', to, text: 'checkpoint' })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^Refused \(unknown\): no session on this computer has the id or name/)
      expect(r.text).toContain('Mail does not reach sessions on other computers yet.')
      expect(r.text).not.toMatch(/gone|Not a mail address|bad_address/)
    }
  })
})

describe('an answer to a request its sender withdrew', () => {
  it('still goes, and the answer says the request was withdrawn; an answer to one that stands says nothing of it', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'Is #12 still open?', needsReply: true })
    const p = w.mail.send(A, { to: [B], text: 'Is #13 still open?', needsReply: true })
    w.store.mailbox.settle(q.message.id, B, 'withdrawn', Date.now())
    const late = w.run('b', { action: 'reply', thread: q.message.id, text: 'yes' })
    expect(late.text).toContain(`It answers ${q.message.id} from alpha (its sender withdrew it).`)
    expect(w.row(q.message.id, B)!.settled).toBe('withdrawn')
    expect(w.run('b', { action: 'reply', thread: p.message.id, text: 'yes' }).text).not.toContain('withdrew')
    // The person's own request, closed from the Inbox
    const ask = w.mail.send(PERSON, { to: [B], text: 'Which branch?', needsReply: true })
    w.store.mailbox.settle(ask.message.id, B, 'withdrawn', Date.now())
    expect(w.run('b', { action: 'reply', thread: ask.message.id, text: 'main' }).text).toContain('(the person withdrew it)')
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
