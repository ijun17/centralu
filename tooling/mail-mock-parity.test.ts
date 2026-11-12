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
 * window reads off the list after each step is compared; the host's own rules are tested in agent-host's person.test.ts, this only keeps the mock from leading it.
 */

const A = at('a')

type Step = Pick<MailThreadRow, 'unread' | 'state'> & { open: number }
type Driver = { asks(...texts: string[]): Promise<void>; answerOldest(text: string): Promise<void>; row(): Promise<MailThreadRow> }

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

const step = (r: MailThreadRow): Step => ({ unread: r.unread, state: r.state, open: r.ask?.open.length ?? 0 })
/** The question the list names as the oldest open one: the list is read, the thread is not (opening it would read it) */
const oldest = (r: MailThreadRow): string => r.ask!.open[0]!

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
    async asks(note, ...texts) {
      root = w.service.send(A, { to: [PERSON], text: note, needsReply: false }).message.id
      for (const text of texts) {
        w.clock.t += 10
        w.service.send(A, { to: [PERSON], text, replyTo: root, needsReply: true })
      }
    },
    async answerOldest(text) {
      person.reply(root, text, 'answer', oldest(person.list().threads[0]!))
    },
    async row() {
      return person.list().threads[0]!
    },
  }
}

function mockDriver(): Driver {
  const mock = new MailMock(new MockClock(() => Date.now()), () => {})
  const from = mockSessionParty('a', 'a')
  let thread: string | null = null
  return {
    async asks(note, ...texts) {
      thread = mock.seed({ subject: note, from, body: note, kind: 'note' })
      for (const body of texts) mock.say(thread, { from, body })
    },
    async answerOldest(text) {
      await mock.mail.reply(thread!, text, 'answer', oldest((await mock.mail.list()).threads[0]!))
    },
    async row() {
      return (await mock.mail.list()).threads[0]!
    },
  }
}

async function play(d: Driver): Promise<Step[]> {
  const seen: Step[] = []
  await d.asks('Fixed it.', 'First?', 'Second?')
  seen.push(step(await d.row()))
  // An answer from the list's card, with the thread never opened: it reads the question it answers and what came before it, and no more
  await d.answerOldest('x')
  seen.push(step(await d.row()))
  await d.answerOldest('y')
  seen.push(step(await d.row()))
  return seen
}

describe('the mock mailbox and the host answer the same script the same way (#2233)', () => {
  it('two questions, each answered from the list without opening the thread: unread and what is open after each step are the host’s', async () => {
    const host = await play(hostDriver())
    // Written out as well, so a change that moves both together is still seen
    expect(host).toEqual([
      { unread: 3, state: 'open', open: 2 },
      { unread: 1, state: 'open', open: 1 },
      { unread: 0, state: 'open', open: 0 },
    ])
    expect(await play(mockDriver())).toEqual(host)
  })

  it('a reply to the first question leaves a newer one unread, on both (the answer reads up to what it answers)', async () => {
    for (const d of [hostDriver(), mockDriver()]) {
      await d.asks('Fixed it.', 'First?', 'Second?')
      await d.answerOldest('x')
      expect((await d.row()).unread).toBe(1)
    }
  })
})
