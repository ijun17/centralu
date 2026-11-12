import { afterEach, describe, expect, it } from 'vitest'
import type { MailThreadRow } from '@cc/protocol'
import { MailMock, mockSessionParty } from '../packages/platform/src/mock/mail.js'
import { MockClock } from '../packages/platform/src/mock/clock.js'
import { at, hostWorld } from '../packages/agent-host/src/mail/host-mail.test-helpers.js'
import { PERSON } from '../packages/agent-host/src/mail/address.js'
import { MailPerson } from '../packages/agent-host/src/mail/person.js'

/**
 * The mock mailbox (`MailMock`, what `?mock=1`, `?demo` and the UI's e2e run on) answers as the host's `MailPerson` does (#2233). The mock once set a row's `unread` to 0 on a
 * reply while the host did not: every e2e on the card passed on the mock and the card stayed on screen against the real host. The same script is played on both and what the
 * window reads off the list after each step is compared whole (the row's `ask`, its unread count, its state and the kind of its last message), with the ids that differ between the
 * two replaced by the question's own words. The host's rules are tested in agent-host's person.test.ts. The mock cannot import the host's `asking()` (a platform package takes nothing
 * from agent-host), so it writes the same rule again, and this test is what keeps the two from drifting: change one and it fails until the other follows.
 */

const A = at('a')
const QUESTIONS = ['First?', 'Second?']
const CHOICES = ['x', 'y']

type Which = 'oldest' | 'newest' | 'free'
type Driver = { asks(): Promise<void>; answer(text: string, which: Which): Promise<void>; close(): Promise<void>; row(): Promise<MailThreadRow> }

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

/** What a window reads off the list, the two questions' ids told by their order */
function look(r: MailThreadRow, ids: readonly string[]) {
  const name = (id: string) => QUESTIONS[ids.indexOf(id)]
  return {
    unread: r.unread,
    state: r.state,
    last: r.last?.kind,
    ask: r.ask && { newest: name(r.ask.id), open: r.ask.open.map(name), text: r.ask.text, choices: r.ask.choices, sender: { kind: r.ask.sender.kind, sessionId: r.ask.sender.sessionId, name: r.ask.sender.name } },
  }
}

/** The question the list names as the one an answer goes to: the list is read, the thread is not (opening it would read it) */
const target = (r: MailThreadRow, which: Which): string | undefined => (which === 'oldest' ? r.ask!.open[0] : which === 'newest' ? r.ask!.open.at(-1) : undefined)

function hostDriver(): Driver {
  const w = hostWorld()
  w.afterReady()
  stops.push(w.stop)
  const person = new MailPerson(w.service, w.store.mailbox, w.delivery, {
    session: (id) => ({ name: id, state: 'idle' }),
    legacyChain: (threadId) => w.store.legacyChain(threadId, undefined, 100),
    projectLabel: (projectId) => w.reach.projectLabel(projectId),
    untrusted: (projectId) => w.reach.untrusted(projectId),
    turnOn: () => undefined,
    tellsNow: () => false,
    tell: async () => {},
  })
  let root = ''
  return {
    // A note opens the chain and each question is written to answer it, so no question answers another
    async asks() {
      root = w.service.send(A, { to: [PERSON], text: 'Fixed it.', needsReply: false }).message.id
      for (const [i, text] of QUESTIONS.entries()) {
        w.clock.t += 10
        w.service.send(A, { to: [PERSON], text, replyTo: root, needsReply: true, ...(i === 0 ? { choices: CHOICES } : {}) })
      }
    },
    async answer(text, which) {
      const id = target(person.list().threads[0]!, which)
      if (id === undefined) person.reply(root, text)
      else person.reply(root, text, 'answer', id)
    },
    async close() {
      person.close(root)
    },
    async row() {
      return person.list().threads[0]!
    },
  }
}

function mockDriver(): Driver {
  const mock = new MailMock(new MockClock(() => Date.now()), () => {})
  const from = mockSessionParty('a', 'a')
  let thread = ''
  return {
    async asks() {
      thread = mock.seed({ subject: 'Fixed it.', from, body: 'Fixed it.', kind: 'note' })
      for (const [i, body] of QUESTIONS.entries()) mock.say(thread, { from, body, ...(i === 0 ? { choices: CHOICES } : {}) })
    },
    async answer(text, which) {
      const id = target((await mock.mail.list()).threads[0]!, which)
      if (id === undefined) await mock.mail.reply(thread, text)
      else await mock.mail.reply(thread, text, 'answer', id)
    },
    async close() {
      await mock.mail.close(thread)
    },
    async row() {
      return (await mock.mail.list()).threads[0]!
    },
  }
}

/** One script: ask two questions, then the steps; what is read off the list after each */
async function play(d: Driver, steps: (readonly [string, Which] | 'close')[]) {
  await d.asks()
  const ids = (await d.row()).ask!.open
  const seen = [look(await d.row(), ids)]
  for (const s of steps) {
    if (s === 'close') await d.close()
    else await d.answer(s[0], s[1])
    seen.push(look(await d.row(), ids))
  }
  return seen
}

const SCRIPTS: Record<string, (readonly [string, Which] | 'close')[]> = {
  'the oldest answered first, then the other': [['x', 'oldest'], ['own words', 'oldest']],
  'the newer answered first (what is before it is read, the older still asks), then the older': [['own words', 'newest'], ['y', 'oldest']],
  'a free reply answers the newest, and the older still asks': [['for the newest', 'free'], ['for the other', 'free']],
  'closed from the list, with the thread never opened: read, done, nothing asks': ['close'],
  'answered, then closed': [['x', 'oldest'], 'close'],
}

describe('the mock mailbox and the host answer the same script the same way (#2233)', () => {
  it.each(Object.keys(SCRIPTS))('%s', async (name) => {
    const host = await play(hostDriver(), SCRIPTS[name]!)
    expect(await play(mockDriver(), SCRIPTS[name]!)).toEqual(host)
  })

  it('the host’s own numbers, written out, so that a change that moves both together is still seen', async () => {
    const [start, afterOldest, afterNewest] = [await play(hostDriver(), []), await play(hostDriver(), [['x', 'oldest']]), await play(hostDriver(), [['own', 'newest']])]
    expect(start[0]).toMatchObject({ unread: 3, state: 'open', ask: { newest: 'Second?', open: ['First?', 'Second?'] } })
    // An answer to the older question reads up to it: the newer one is still unread and still asks
    expect(afterOldest[1]).toMatchObject({ unread: 1, ask: { newest: 'Second?', open: ['Second?'] } })
    // An answer to the newer one reads everything before it, and the older one still asks
    expect(afterNewest[1]).toMatchObject({ unread: 0, ask: { newest: 'First?', open: ['First?'], choices: CHOICES } })
  })
})
