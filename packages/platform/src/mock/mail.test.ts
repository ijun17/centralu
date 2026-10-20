/**
 * The mock mailbox (#1347): what a screen built against it sees. It keeps the host's rules that a screen shows, and the events a
 * change sends.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { createMockPlatform } from './index.js'
import { mockSessionParty } from './mail.js'

const worker = mockSessionParty('s1', 'Parser')

describe('the mock mailbox', () => {
  it('lists a seeded thread unread, reads it once, and tells the screen when it changes', async () => {
    const p = createMockPlatform()
    const heard: NormalizedEvent[] = []
    p.agents.subscribe((e) => void heard.push(e))
    const id = p.seedMail({ subject: 'Which branch?', from: worker, body: 'main or release?' })
    expect(heard).toEqual([{ type: 'mail_changed', threadId: id, toPerson: true }])

    expect((await p.mail.list()).threads).toMatchObject([{ id, unread: 1, subject: 'Which branch?', owner: { name: 'Parser' } }])
    const view = await p.mail.thread(id)
    expect(view.messages.map((m) => m.body)).toEqual(['main or release?'])
    expect((await p.mail.list()).threads[0]!.unread).toBe(0)
    expect((await p.mail.thread(id)).messages).toEqual([])
  })

  it('opens a long thread at its end and gives the earlier part page by page', async () => {
    const p = createMockPlatform()
    const id = p.seedMail({ subject: 'long', from: worker, body: 'm1' })
    for (let i = 2; i <= 30; i++) await p.mail.reply(id, `m${i}`)
    const end = await p.mail.thread(id, { tail: 10 })
    expect(end.messages.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 21}`))
    expect(end.older).toBe(true)
    expect((await p.mail.list()).threads[0]!.unread).toBe(0)
    const earlier = await p.mail.thread(id, { tail: 10, before: 21 })
    expect(earlier.messages.map((m) => m.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 11))
    expect((await p.mail.thread(id, { tail: 30, before: 11 })).older).toBe(false)
  })

  it('takes the person’s reply as theirs, refuses one to a thread that is done, and a thread that is not there', async () => {
    const p = createMockPlatform()
    const id = p.seedMail({ subject: 'q', from: worker, body: 'b' })
    const sent = await p.mail.reply(id, 'the release branch', 'answer')
    expect(sent.messages).toMatchObject([{ kind: 'answer', sender: { address: 'person' }, body: 'the release branch' }])
    expect((await p.mail.close(id, 'finished')).state).toBe('done')
    await expect(p.mail.reply(id, 'more')).rejects.toMatchObject({ code: 'refused' })
    await expect(p.mail.thread('nope')).rejects.toMatchObject({ code: 'refused' })
  })

  it('shows held mail with its reason until the person releases or dismisses it, and a blocker until it is resolved', async () => {
    const p = createMockPlatform()
    const id = p.seedMail({ subject: 'work', from: mockSessionParty('s0', 'Boss'), body: 'do it', kind: 'assign', held: { reason: 'loop', recipient: worker } })
    const { held, threads } = await p.mail.list()
    expect(held).toMatchObject([{ threadId: id, reason: 'loop', recipient: { name: 'Parser' } }])
    expect(threads[0]!.held).toBe(1)
    expect(await p.mail.held('release', worker.address, [held[0]!.messageId])).toEqual({ changed: 1 })
    expect((await p.mail.list()).held).toEqual([])

    p.mockMail.block(id, 'waiting for a design')
    expect((await p.mail.list()).threads[0]).toMatchObject({ state: 'blocked', blocked: 1 })
    expect((await p.mail.unblock(id, 1)).state).toBe('open')
    await expect(p.mail.unblock(id, 1)).rejects.toMatchObject({ code: 'refused' })
  })

  it('a pause lifted sends what it held: a thread’s turns, or a session’s budget', async () => {
    const p = createMockPlatform()
    const boss = mockSessionParty('s0', 'Boss')
    p.seedMail({ subject: 'a', from: boss, body: 'x', held: { reason: 'budget', recipient: worker } })
    const looped = p.seedMail({ subject: 'b', from: boss, body: 'y', held: { reason: 'loop', recipient: worker } })
    await p.mail.resume({ threadId: looped })
    expect((await p.mail.list()).held.map((h) => h.reason)).toEqual(['budget'])
    await p.mail.resume({ sessionId: 's9' })
    expect((await p.mail.list()).held).toHaveLength(1)
    await p.mail.resume({ sessionId: 's1' })
    expect((await p.mail.list()).held).toEqual([])
  })

  it('remembers what the person pressed, and the crowd waits no more once answered', async () => {
    const p = createMockPlatform()
    p.mockMail.waiting = 12
    expect((await p.mail.list()).waiting).toBe(12)
    await p.mail.wake(true)
    await p.mail.resume({ sessionId: 's1' })
    await p.mail.resume({ threadId: 't' })
    expect((await p.mail.list()).waiting).toBe(0)
    expect(p.mockMail.calls).toEqual(['wake:true', 'resume:session:s1', 'resume:thread:t'])
  })
})
