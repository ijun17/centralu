/**
 * The person's mailbox in the store (#1347): the list is a copy the host's news keeps current, a thread opened in the Inbox is
 * read for the person, and the acts that are theirs go to the host and say why when it refuses. Ports go through `MockPlatform`
 * (the header of platform/src/mock/index.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform, mockSessionParty } from '@cc/platform/mock'
import { notifyPolicyOf } from '@cc/protocol/client'
import { useStore } from './store.js'
import { mailAttention } from './mail.js'
import { resetStore } from './store.test-helpers.js'

beforeEach(resetStore)

const worker = mockSessionParty('s1', 'Parser')

/** A store attached to a mock, as the app attaches one: its events reach `dispatchEvent` */
function attached() {
  const platform = new MockPlatform()
  useStore.setState({ platform })
  platform.agents.subscribe((e) => useStore.getState().dispatchEvent(e))
  return platform
}

describe('the list', () => {
  it('is read, kept current by the host’s news, and counts the threads that want the person', async () => {
    const platform = attached()
    await useStore.getState().loadMail()
    expect(useStore.getState().mail).toEqual({ threads: [], held: [], waiting: 0 })
    expect(mailAttention(useStore.getState().mail)).toBe(0)

    const id = platform.seedMail({ subject: 'Which branch?', from: worker, body: 'main or release?' })
    await vi.waitFor(() => expect(useStore.getState().mail?.threads.map((t) => t.id)).toEqual([id]))
    expect(mailAttention(useStore.getState().mail)).toBe(1)

    await useStore.getState().openMailThread(id)
    await vi.waitFor(() => expect(mailAttention(useStore.getState().mail)).toBe(0))
  })

  it('counts held mail in a thread the person is not in, and the crowd question, once each', () => {
    const row = { id: 't', subject: 's', state: 'open', outcome: null, next: null, projectId: null, owner: worker, assignee: null, unread: 0, held: 0, blocked: 0, createdAt: 0, updatedAt: 0, last: null }
    const held = { messageId: 'm', threadId: 'elsewhere', subject: 's', sender: worker, recipient: worker, kind: 'assign', reason: 'loop', preview: '', since: 0 }
    expect(mailAttention({ threads: [row], held: [held, { ...held, messageId: 'n' }], waiting: 0 })).toBe(1)
    expect(mailAttention({ threads: [row], held: [], waiting: 12 })).toBe(1)
    expect(mailAttention({ threads: [{ ...row, unread: 1 }], held: [{ ...held, threadId: 't' }], waiting: 12 })).toBe(2)
  })

  it('counts a thread with mail held for the person too, and nothing before it is read', () => {
    expect(mailAttention(null)).toBe(0)
    const row = { id: 't', subject: 's', state: 'open', outcome: null, next: null, projectId: null, owner: worker, assignee: null, unread: 0, held: 1, blocked: 0, createdAt: 0, updatedAt: 0, last: null }
    expect(mailAttention({ threads: [row, { ...row, id: 'u', held: 0 }], held: [], waiting: 0 })).toBe(1)
  })

  it('stays what it was, quietly, when the host has no mailbox', async () => {
    const platform = new MockPlatform()
    platform.mail.list = async () => {
      throw new Error('Unknown method: mail.list')
    }
    useStore.setState({ platform })
    await useStore.getState().loadMail()
    expect(useStore.getState().mail).toBeNull()
    expect(useStore.getState().toast).toBeNull()
  })

  it('a news that comes while it is being read asks for one more read, not one each', async () => {
    const platform = new MockPlatform()
    let reads = 0
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const real = platform.mail.list
    platform.mail.list = async () => {
      reads++
      if (reads === 1) await held
      return real()
    }
    useStore.setState({ platform })
    const first = useStore.getState().loadMail()
    void useStore.getState().loadMail()
    void useStore.getState().loadMail()
    release()
    await first
    expect(reads).toBe(2)
  })
})

describe('a thread in the Inbox', () => {
  it('is opened read for the person, takes their reply once the host has it, and shows what comes after', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'q', from: worker, body: 'which?' })
    await useStore.getState().openMailThread(id)
    expect(useStore.getState().mailThread?.messages.map((m) => m.body)).toEqual(['which?'])

    expect(await useStore.getState().replyMail('the release branch', 'answer')).toBe(true)
    expect(useStore.getState().mailThread?.messages.map((m) => [m.sender.address, m.body])).toEqual([
      [worker.address, 'which?'],
      ['person', 'the release branch'],
    ])
    // Nothing is shown twice when the news of the reply comes back
    await vi.waitFor(() => expect(useStore.getState().mail?.threads[0]?.last?.preview).toBe('the release branch'))
    expect(useStore.getState().mailThread?.messages).toHaveLength(2)
    useStore.getState().closeMailThread()
    expect(useStore.getState().mailThread).toBeNull()

    // Opened again, it shows what was said, not only what came since
    await useStore.getState().openMailThread(id)
    expect(useStore.getState().mailThread?.messages.map((m) => m.body)).toEqual(['which?', 'the release branch'])
  })

  it('opens a long thread at its newest messages, and goes back a page at a time', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'long', from: worker, body: 'm1' })
    for (let i = 2; i <= 130; i++) await platform.mail.reply(id, `m${i}`)
    await useStore.getState().openMailThread(id)
    const open = useStore.getState().mailThread!
    expect(open.messages).toHaveLength(100)
    expect(open.messages.at(-1)?.body).toBe('m130')
    expect(open.older).toBe(true)
    await vi.waitFor(() => expect(mailAttention(useStore.getState().mail)).toBe(0))

    await useStore.getState().loadOlderMail()
    const all = useStore.getState().mailThread!
    expect(all.messages.map((m) => m.seq)).toEqual(Array.from({ length: 130 }, (_, i) => i + 1))
    expect(all.older).toBe(false)
    // A message that comes after keeps what is held and what is said of earlier ones
    expect(await useStore.getState().replyMail('and now')).toBe(true)
    expect(useStore.getState().mailThread!.messages).toHaveLength(131)
    expect(useStore.getState().mailThread!.older).toBe(false)
  })

  it('a message that comes after is added to a long thread without losing that there is more before', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'long', from: worker, body: 'm1' })
    for (let i = 2; i <= 130; i++) await platform.mail.reply(id, `m${i}`)
    await useStore.getState().openMailThread(id)
    expect(useStore.getState().mailThread!.older).toBe(true)
    expect(await useStore.getState().replyMail('and now')).toBe(true)
    expect(useStore.getState().mailThread!.messages.at(-1)?.body).toBe('and now')
    expect(useStore.getState().mailThread!.older).toBe(true)
  })

  it('says why when the host refuses, and shows nothing it did not accept', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'q', from: worker, body: 'which?' })
    await useStore.getState().openMailThread(id)
    expect(await useStore.getState().closeMail('finished')).toBe(true)
    await vi.waitFor(() => expect(useStore.getState().mailThread?.thread.state).toBe('done'))

    expect(await useStore.getState().replyMail('more')).toBe(false)
    expect(useStore.getState().toast).toBe('Could not send that: this thread is done; open a follow-up')
    expect(useStore.getState().mailThread?.messages.map((m) => m.body)).toEqual(['which?'])
  })

  it('says what failed when a close is refused, and the same for a thread that cannot be opened', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'q', from: worker, body: 'which?' })
    await useStore.getState().openMailThread(id)
    platform.mail.close = async () => {
      throw new Error('disk full')
    }
    expect(await useStore.getState().closeMail('dropped')).toBe(false)
    expect(useStore.getState().toast).toBe('Could not close this mail: disk full')
    platform.mail.thread = async () => {
      throw new Error('gone')
    }
    await useStore.getState().openMailThread(id)
    expect(useStore.getState().toast).toBe('Could not open this mail: gone')
  })

  it('closing a thread a session is working on reads back the host’s close at once: done as dropped, no longer working, and nothing stopped', async () => {
    const platform = attached()
    const id = platform.seedMail({ subject: 'work', from: worker, body: 'do it', kind: 'assign', state: 'running', assignee: worker, working: true })
    await useStore.getState().openMailThread(id)
    expect(useStore.getState().mailThread?.thread).toMatchObject({ state: 'running', working: true })
    expect(await useStore.getState().closeMail('dropped')).toBe(true)
    await vi.waitFor(() => expect(useStore.getState().mailThread?.thread).toMatchObject({ state: 'done', outcome: 'dropped', working: false }))
    expect(platform.mockMail.calls).toEqual([])
  })
})

describe('mail held for the person', () => {
  it('goes now on Release, is let go on Dismiss, and a pause is lifted on Resume', async () => {
    const platform = attached()
    platform.seedMail({ subject: 'a', from: worker, body: 'x', held: { reason: 'loop', recipient: worker } })
    platform.seedMail({ subject: 'b', from: worker, body: 'y', held: { reason: 'budget', recipient: worker } })
    await useStore.getState().loadMail()
    const [first, second] = useStore.getState().mail!.held
    expect(await useStore.getState().heldMail('release', first!)).toBe(true)
    expect(await useStore.getState().heldMail('dismiss', second!)).toBe(true)
    expect(useStore.getState().mail?.held).toEqual([])

    expect(await useStore.getState().resumeMail({ sessionId: 's1' })).toBe(true)
    expect(await useStore.getState().resumeMail({ threadId: 't' })).toBe(true)
    platform.mockMail.waiting = 4
    await useStore.getState().loadMail()
    expect(useStore.getState().mail?.waiting).toBe(4)
    expect(await useStore.getState().wakeMail(false)).toBe(true)
    expect(useStore.getState().mail?.waiting).toBe(0)
    expect(platform.mockMail.calls.filter((c) => /^(release|dismiss|resume|wake)/.test(c))).toEqual([
      `release:${worker.address}:${first!.messageId}`,
      `dismiss:${worker.address}:${second!.messageId}`,
      'resume:session:s1',
      'resume:thread:t',
      'wake:false',
    ])
  })
})

describe('the OS notification for mail (#1630)', () => {
  it('a new message the host names raises one notification and one alert, a question as mail and never as an approval; any other change raises none', async () => {
    const platform = attached()
    // The approval switch is not mail's: off, a question still calls the person
    useStore.setState((s) => ({ appFocused: false, prefs: { ...s.prefs, notifyPolicy: { ...notifyPolicyOf(s.prefs), approval: false } } }))
    const at = { type: 'mail_changed', threadId: 'm1', toPerson: true } as const
    useStore.getState().dispatchEvent({ ...at, arrived: { messageId: 'm1', from: worker, kind: 'question', preview: 'Which branch?' } })
    useStore.getState().dispatchEvent({ ...at, arrived: { messageId: 'm2', from: { address: 'centralu', kind: 'centralu', sessionId: null, name: null, state: null }, kind: 'notice', preview: 'Done.' } })
    // A read mark, a close, the person's own message: no `arrived`
    useStore.getState().dispatchEvent(at)
    await vi.waitFor(() => expect(platform.alerts).toHaveLength(2))
    expect(platform.notifications).toEqual([
      { title: 'Question from Parser', body: 'Which branch?' },
      { title: 'Mail from Centralu', body: 'Done.' },
    ])
    expect(platform.alerts.map((a) => a.kind)).toEqual(['done', 'done'])
  })
})
