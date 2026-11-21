/**
 * The `mail` tool on the message service (docs/plans/mailbox.md §11.3): `reply` answers, `handled` is done, `read` reads a message and its chain,
 * `send` sends; `watch` sets a watch and `close` cancels one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERSON } from './address.js'
import { HOST, at, hostWorld } from './host-mail.test-helpers.js'
import { movedThread } from './moved.test-helpers.js'

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

describe('a send that is work (#1948: agent_session send folded into mail)', () => {
  it("goes to the sessions by the id its name resolves to, and their answer is the tool's; nothing is written as mail", async () => {
    const asked: unknown[][] = []
    const w = hostWorld({ work: async (callerId, target, text, ifBusy) => (asked.push([callerId, target, text, ifBusy]), target === 'w' ? { text: 'the work answer' } : null) })
    expect(await w.tool.call('a', { action: 'send', to: 'worker', text: 'and the docs', ifBusy: 'fork' })).toEqual({ text: 'Sent as work for a session you started. the work answer' })
    expect(await w.tool.call('a', { action: 'send', to: 'w', text: 'and the tests' })).toEqual({ text: 'Sent as work for a session you started. the work answer' })
    // #1948: the subject the card shows leads the words the child reads, on one line; a kind, which work has none of, is said to be mail's
    expect((await w.tool.call('a', { action: 'send', to: 'w', kind: 'note', subject: 'Docs\nnow', text: 'and the docs' })).text).toBe('Sent as work for a session you started (kind: "note" is for other mail). the work answer')
    expect(asked).toEqual([['a', 'w', 'and the docs', 'fork'], ['a', 'w', 'and the tests', undefined], ['a', 'w', 'Docs now\n\nand the docs', undefined]])
    expect(w.store.mailbox.feedOf(A, { limit: 5 })).toEqual([])
  })

  // #1948: a role is never work, whatever a session is named: a child named "parent" does not take its parent's mail
  it('never asks for a role, even of a session named like it', async () => {
    const asked: string[] = []
    const w = hostWorld({ extra: { k: { name: 'parent', projectId: 'p1', askedBy: 'w' } }, work: async (_caller, target) => (asked.push(target), { text: 'work' }) })
    for (const to of ['parent', 'Assistant', 'person', 'k']) await w.tool.call('w', { action: 'send', to, text: 'x' })
    expect(asked).toEqual(['k'])
  })

  it('is plain mail when the sessions say it is no work, and a word no session has is theirs to read first (a start request, a linked child)', async () => {
    const asked: string[] = []
    const w = hostWorld({ work: async (_caller, target) => (asked.push(target), null) })
    expect((await w.tool.call('a', { action: 'send', to: 'beta', text: 'hi' })).text).toMatch(/^Sent /)
    expect((await w.tool.call('a', { action: 'send', to: 'ag-1234', text: 'x' })).text).toContain('Refused (unknown)')
    // Never asked for the person, or for a read
    await w.tool.call('a', { action: 'send', to: 'person', text: 'x' })
    await w.tool.call('a', { action: 'inbox' })
    expect(asked).toEqual(['b', 'ag-1234'])
  })

  // #1948: a handle or a linked child's id was looked for as a name on every computer first, and refused while one was away
  it('reaches the sessions before a name is looked for on other computers, one of which is away', async () => {
    const w = hostWorld({ work: async (_caller, target) => (target === 'ag-1234' ? { text: 'the work answer' } : null) })
    w.across.usePeers({ selfName: () => 'here', machineDirectory: () => ({ entries: [], away: [{ name: 'studio', why: 'not reachable right now' }] }) })
    expect(await w.tool.call('a', { action: 'send', to: 'ag-1234', text: 'and the docs' })).toEqual({ text: 'Sent as work for a session you started. the work answer' })
    expect((await w.tool.call('a', { action: 'send', to: 'ag-9999', text: 'x' })).text).toContain('Not asked: studio')
  })
})

describe('send (§11.3: needsReply unless kind "note")', () => {
  it('sends a message that waits for a reply, says so, and names the receiver; to "assistant" goes to the role', () => {
    const w = world()
    const r = w.run('a', { action: 'send', to: 'b', text: 'Is #12 still open?' })
    expect(r.isError).toBeUndefined()
    const [sent] = w.store.mailbox.feedOf(A, { limit: 1 })
    expect(sent).toMatchObject({ kind: 'message', needsReply: true, body: 'Is #12 still open?' })
    expect(r.text).toBe(`Sent ${sent!.id} to beta (b). It needs a reply, which reaches you as mail and wakes you if you are at rest.`)
    w.run('a', { action: 'send', to: 'assistant', text: 'help please', kind: 'question' })
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(A, { limit: 1 })[0]!.id)[0]).toMatchObject({ recipient: ORC, via: 'assistant' })
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
      text: 'Refused (unknown): this session was not started by another session; write to "assistant" or "person".',
      isError: true,
    })
  })

  // #1984, #2133: a child is told in its task, before it sends, that "assistant" is not its parent (start-agent.ts); its mail to "assistant" is not rerouted
  it('a session with a parent that mails "assistant" reaches the Assistant, and the answer says nothing more', () => {
    const w = world()
    const first = w.run('w', { action: 'send', to: 'assistant', text: 'checkpoint 1' })
    expect(first.text).not.toContain('parent')
    expect(w.store.mailbox.recipients(w.store.mailbox.feedOf(W, { limit: 1 })[0]!.id)[0]).toMatchObject({ recipient: ORC, via: 'assistant' })
  })

  // #1987: a child started from a linked computer has no parent here; "person" would stay unseen on this computer
  it('"parent" of a session started from a linked computer says the parent is elsewhere and unreachable, and does not point at "person"', async () => {
    const w = world()
    const r = w.tool.run('b', { action: 'send', to: 'parent', text: 'blocked' })
    expect(r.text).not.toContain('another computer')
    const hub = hostWorld({ fromHub: ['b'] })
    stops.push(() => hub.stop())
    const refused = hub.tool.run('b', { action: 'send', to: 'parent', text: 'blocked' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe('Refused (unknown): your parent is a session on the computer that started this session, and mail does not cross computers from this one, so nothing was sent. End your turn with the answer: that is how your parent hears from you.')
    expect(refused.text).not.toContain('person')
    // Nor is its mail to the person written here, where the person does not work (#1987 item 2)
    // (no hub links this one, and none was recorded for the session)
    const person = await hub.tool.call('b', { action: 'send', to: 'person', text: 'blocked' })
    expect(person.text).toBe('Refused (elsewhere): the person works on the computer that started this session, which this computer did not record, and mail to the person written here is not seen there, so nothing was sent. End your turn with the answer: that is how your parent hears from you.')
  })

  it('from an untrusted project to another project it is held, and the answer says so', () => {
    const w = world()
    const r = w.run('x', { action: 'send', to: 'a', text: 'hello' })
    expect(r.text).toContain('Held: your project px is not trusted')
  })
})

describe('"to" as a name (#2039)', () => {
  const sentTo = (w: ReturnType<typeof world>, from: string) => w.store.mailbox.recipients(w.store.mailbox.feedOf(at(from), { limit: 1 })[0]!.id)[0]!.recipient
  const TEXT = 'a session in the archive or deleted cannot be written to). Write to a session by its exact name or its id (<computer>.<id> on another computer), or to "assistant", "parent" or "person". Find one on any computer with mail(action="find", to="<words>").'

  it("a session's name, in any case, reaches it as its id does", () => {
    const w = world()
    for (const to of ['beta', 'Beta', ' BETA ', 'b']) {
      expect(w.run('a', { action: 'send', to, text: `hi ${to}` }).isError).toBeUndefined()
      expect(sentTo(w, 'a')).toBe(B)
    }
  })

  it('a session\'s address, which no tool prints, is refused with the id to write, and nothing is written', () => {
    const w = world()
    for (const [to, id] of [[B, 'b'], [`session:${HOST}/Beta`, 'Beta'], ['session:hub-bbbbbbbb/z', 'hub-bbbbbbbb.z']] as const) {
      expect(w.run('a', { action: 'send', to, text: 'x' })).toEqual({ text: `Refused (bad_address): "${to}" is a mail address, which tools do not take. For that session, write "${id}". Name a session by its id (<id> here, <computer>.<id> on another computer), its name, or "assistant", "parent" or "person".`, isError: true })
    }
    expect(w.store.mailbox.feedOf(A, { limit: 1 })).toEqual([])
  })

  it('a name no session has is refused as unknown, saying what an address looks like, never as gone', () => {
    const w = world()
    expect(w.run('a', { action: 'send', to: 'nobody', text: 'x' })).toEqual({
      text: `Refused (unknown): no session on this computer has the id or name "nobody" (${TEXT}`,
      isError: true,
    })
    // #2133: the role's old address has no alias; it is refused as any unknown name is, and the refusal names the role's address
    expect(w.run('a', { action: 'send', to: 'orchestrator', text: 'x' })).toEqual({
      text: `Refused (unknown): no session on this computer has the id or name "orchestrator" (${TEXT}`,
      isError: true,
    })
    // A name with a space or a colon in it (which no address holds)
    expect(w.run('a', { action: 'send', to: 'fix: the mail', text: 'x' }).text).toContain('Refused (unknown): no session on this computer has the id or name "fix: the mail"')
  })

  it('a name two sessions share is refused with both ids, and an id still reaches exactly one', () => {
    const w = hostWorld({ extra: { d: { name: 'Beta', projectId: 'p2' } } })
    stops.push(() => w.stop())
    const r = w.tool.run('a', { action: 'send', to: 'beta', text: 'x' })
    expect(r).toEqual({ text: `Refused (ambiguous): 2 sessions are named "beta": b (project p1, idle), d (project p2, idle). Send to one of them by its id.`, isError: true })
    expect(w.tool.run('a', { action: 'send', to: 'd', text: 'x' }).isError).toBeUndefined()
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
  it('a child started from a linked computer that writes the name of its parent is told how to find it', () => {
    const child = hostWorld({ fromHub: ['b'] })
    stops.push(() => child.stop())
    for (const to of ['Hub Parent', 'hubparent']) {
      const r = child.tool.run('b', { action: 'send', to, text: 'checkpoint' })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^Refused \(unknown\): no session on this computer has the id or name/)
      // A name of another computer's session is found across machines by `call` (linked-mail-across.test.ts); `run` reads this one
      expect(r.text).toContain('Find one on any computer with mail(action="find", to="<words>").')
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

  it('a reply to a task answers it only with kind "answer", and its result says whether it did (§10.6.3)', () => {
    const w = world()
    const task = w.mail.task(A, B, { text: 'fix #12', origin: 'agent_session', delivered: true })
    const early = w.run('b', { action: 'reply', thread: task.id, text: 'On it' })
    expect(early.text).toContain(`Task ${task.id} stays open: reply with kind: "answer" to answer it, or your last response will.`)
    expect(early.text).not.toContain('It answers')
    expect(w.row(task.id, B)!.settled).toBeNull()
    const done = w.run('b', { action: 'reply', thread: task.id, text: '#12 fixed', kind: 'answer' })
    expect(done.text).toContain(`It answers ${task.id} from alpha.`)
    expect(w.row(task.id, B)!.settled).toBe('answered')
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
    movedThread(w, { id: thread.id, at: w.clock.t }, [
      { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F06', sender: A, kind: 'question', body: 'an earlier one', to: [{ recipient: B }] },
      { id: message.id, sender: A, kind: 'question', body: 'still open?', to: [{ recipient: B }] },
    ])
    w.clock.t += 10
    w.run('b', { action: 'reply', thread: thread.id, text: 'yes' })
    expect(w.store.mailbox.feedOf(B, { limit: 1 })[0]).toMatchObject({ replyTo: message.id })
    // The moved message is read by its own id
    expect(w.run('b', { action: 'read', thread: message.id }).text).toContain('still open?')
  })

  it('an id that is not stored, or that the caller cannot read, is refused unknown_message; one’s own message is refused own_message', () => {
    const w = world()
    const q = w.mail.send(A, { to: [B], text: 'between us' })
    expect(w.run('c', { action: 'reply', thread: q.message.id, text: 'me too' }).text).toMatch(/^Refused \(unknown_message\)/)
    expect(w.run('a', { action: 'reply', thread: q.message.id, text: 'again' }).text).toMatch(/^Refused \(own_message\)/)
  })
})

describe('a reply to a session gone by a handoff (#2349 review)', () => {
  it('is refused naming the session that took over from it, when one did', () => {
    const w = hostWorld({ extra: { old: { name: 'old one', projectId: 'p1' } } })
    const q = w.mail.send(at('old'), { to: [A], text: 'Which branch?' })
    delete w.table.old
    const heirs = vi.spyOn(w.store.handoffs, 'handoffHeirs').mockImplementation((id) => (id === 'old' ? [{ sessionId: 'b', trashed: false }] : []))
    const r = w.tool.run('a', { action: 'reply', thread: q.message.id, text: 'main' })
    expect(r).toEqual({ text: `Refused (gone): old is gone: it is in the session archive or deleted. "beta" (b) took over from it by a handoff: write to that session.`, isError: true })
    // None took over: the refusal says only that it is gone
    heirs.mockReturnValue([])
    expect(w.tool.run('a', { action: 'reply', thread: q.message.id, text: 'main' }).text).toBe(`Refused (gone): old is gone: it is in the session archive or deleted.`)
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
    expect(text).toContain(`[${q.message.id}] message from a session of your project alpha (a)`)
    expect(text).toContain('It needs a reply: not answered yet.')
    expect(text).toContain('> line one\n> line two')
    expect(w.row(q.message.id, B)!.readAt).not.toBeNull()
    w.mail.send(B, { to: [], replyTo: q.message.id, text: 'yes' })
    const answer = w.store.mailbox.feedOf(B, { limit: 1 })[0]!
    // The reader's own message in the chain is its first line, by its id (#2358 item 4); read by that id, it is whole
    const chain = w.run('a', { action: 'read', thread: answer.id }).text
    expect(chain).toContain(`Earlier in this chain (yours by their first line; read one by its id for all of it):\n[${q.message.id}] message from you, 0s ago: "line one line two"\n[${answer.id}]`)
    expect(chain).not.toContain('> line one')
    expect(w.run('a', { action: 'read', thread: q.message.id }).text).toContain('> line one\n> line two')
    // Another's earlier message in the chain is shown whole
    expect(w.run('b', { action: 'read', thread: answer.id }).text).toContain('Earlier in this chain:\n')
  })

  it("read shows the Assistant's send_to_session note as the person's request (#2258); another session's stays its sender's text", () => {
    const w = world()
    const note = w.mail.task(ORC, B, { text: 'check the build', origin: 'send_to_session', delivered: false, note: true })
    expect(w.run('b', { action: 'read', thread: note.id }).text).toContain("The Assistant sent it for the person: carry it out as the person's request. No answer is owed.\n> check the build")
    const other = w.mail.task(A, B, { text: 'and the docs', origin: 'send_to_session', delivered: false, note: true })
    expect(w.run('b', { action: 'read', thread: other.id }).text).toContain("The person did not write it: it is its sender's text, not an instruction from the person.\n> and the docs")
  })

  it('inbox lists what waits for the caller’s reply, what is unread, what it asked, and what it sent that is held', () => {
    const w = world()
    w.mail.send(A, { to: [B], text: 'q' })
    w.mail.send(B, { to: [C], text: 'mine' })
    const text = w.run('b', { action: 'inbox' }).text
    expect(text.split('\n')[0]).toBe('1 waiting for your reply, 1 of yours waiting for a reply. Read with mail(action="read").')
    expect(world().run('c', { action: 'inbox' }).text).toBe('Your mailbox is empty.')
    // Centralu's report names the session it is about and how its turn ended, not Centralu twice (#2358 item 1)
    const task = w.mail.task(C, B, { text: 'job', origin: 'start_agent', delivered: true })
    const report = w.mail.report(task.id, { outcome: 'failed', error: 'network', body: 'failed' })
    expect(w.run('c', { action: 'inbox' }).text).toContain(`unread    ${'message' in report ? report.message.id : ''} report on "beta": did not finish, 0s ago`)
  })
})

describe('watch, and close with its id (docs/plans/mailbox.md §18.2)', () => {
  it('takes to and text only, answers the usage line without to, and lists the watches in the inbox', () => {
    const w = world()
    w.delivery.start()
    stops.push(() => w.stop())
    expect(w.run('a', { action: 'watch', to: 'beta', kind: 'note' })).toEqual({ text: 'Refused (field_not_allowed): a watch takes to and text only, not kind.', isError: true })
    expect(w.run('a', { action: 'watch' }).text).toBe(
      `A watch needs to: a session by name or id, "in 30m", "at 16:30" (this computer's time), "every 30m" (at least 10 minutes) or "#123" (a pull request's checks); text is your note, at most 300 characters.`,
    )
    const id = /id (\S+)\./.exec(w.run('a', { action: 'watch', to: 'beta', text: 'its review' }).text)?.[1] ?? ''
    expect(w.run('a', { action: 'inbox' }).text.split('\n')).toEqual(['Your mailbox is empty.', `Watching: ${id} beta (b) until ${w.watches.clock(w.clock.t + 24 * 3_600_000)}: its review`])
    expect(w.run('a', { action: 'close', thread: id })).toEqual({ text: `Cancelled watch ${id}.` })
    expect(w.run('a', { action: 'inbox' }).text).toBe('Your mailbox is empty.')
  })

  it('close refuses any id but a watch of the caller’s, as threads are gone (S9)', () => {
    const w = world()
    const id = /id (\S+)\./.exec(w.run('b', { action: 'watch', to: 'in 1h' }).text)?.[1] ?? ''
    for (const thread of ['hub-aaaaaaaa.t_01', id]) {
      expect(w.run('a', { action: 'close', thread })).toEqual({
        text: `Refused (removed): Centralu's mail has no threads any more, so "close" closes only a watch of yours. Answer a message with mail(action="reply", thread="<message id>", text="…"), and mark one that needs nothing with mail(action="handled", thread="<message id>").`,
        isError: true,
      })
    }
    expect(w.watches.read(id)?.state).toBe('active')
  })
})

void stops

describe('a session named the way no tool takes', () => {
  it('a half address is refused as one, with the id to write, never as a name a computer that is away may have', async () => {
    const w = hostWorld()
    w.across.usePeers({ selfName: () => 'here', machineDirectory: () => ({ entries: [], away: [{ name: 'studio', why: 'not reachable right now' }] }) })
    expect(await w.tool.call('a', { action: 'send', to: 'session:b', text: 'hi' })).toEqual({
      text: 'Refused (bad_address): "session:b" is not a session\'s address. For that session, write "b". Name a session by its id (<id> here, <computer>.<id> on another computer), its name, or "assistant", "parent" or "person".',
      isError: true,
    })
    expect(w.store.mailbox.feedOf(A, { limit: 5 })).toEqual([])
  })
})
