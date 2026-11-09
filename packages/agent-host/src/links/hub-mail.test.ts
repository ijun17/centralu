import { afterEach, describe, expect, it } from 'vitest'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import type { RemoteAgent } from '../sessions/remote-agents.js'
import { addressOf } from '../sessions/host-mail.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The hub's side of `hub.mail` (#2067 item 1, docs/plans/linked-mail.md §3): a session the hub started on a linked
 * machine mails the session here that started it. The machine's call is made by hand on the hub's own connection, as
 * the reverse-asks tests make theirs; the machine's side is linked-mail.test.ts.
 */

afterEach(runCleanups)

const child = (sessionId: string, callerId = 'h1'): RemoteAgent => ({ sessionId: `m1.${sessionId}`, callerId, machineId: 'm1', machine: 'Remote box', name: sessionId, tool: 'claude', project: 'remote-project', startedAt: 1 })

/** A machine and a hub that started `c1` there, linked; the hub's switch for asks stays off */
async function rig(mail: true | 'before' = true) {
  const machine = await machineHost()
  const hub = await hubHost(machine.port, { mail, children: [child('c1')] })
  await eventually(() => hub.machine().status === 'connected')
  const client = [...(machine.server as unknown as { byClient: Map<number, unknown> }).byClient.keys()][0]!
  const call = (params: unknown) => machine.server.call(client, 'hub.mail', params)
  return { machine, hub, call }
}

describe('the hub takes mail from a session it started on a linked machine (#2067 item 1)', () => {
  it('writes it from that session to the one that started it, whatever the asks switch says', async () => {
    const { hub, call } = await rig()
    expect(hub.machine().asks).toEqual({ on: false, note: null })
    const r = (await call({ sessionId: 'c1', text: 'the build is green', urgent: true })) as { ok: true; messageId: string; to: string }
    expect(r).toEqual({ ok: true, messageId: expect.any(String), to: 'h1' })
    expect(hub.store.mailbox.message(r.messageId)).toMatchObject({ sender: addressOf('m1.c1'), body: 'the build is green', needsReply: false })
    expect(hub.store.mailbox.recipient(r.messageId, addressOf('h1'))).toBeTruthy()
    // The parent reads it from the child by its name on its machine
    expect(hub.mail!.service.labelOf(addressOf('m1.c1'))).toBe('c1 on Remote box')
    expect(await call({ sessionId: 'c1', text: 'fyi', needsReply: false })).toMatchObject({ ok: true })
  })

  it('writes it as a note, so the parent going leaves no notice for the child that could never reach it', async () => {
    const { hub, call } = await rig()
    // The machine asks for a reply; until item 2 neither a reply nor the "no longer watched" notice reaches the child there
    const r = (await call({ sessionId: 'c1', text: 'which branch?', needsReply: true })) as { ok: true; messageId: string }
    expect(hub.store.mailbox.message(r.messageId)).toMatchObject({ needsReply: false })
    hub.mail!.service.partyGone(addressOf('h1'))
    // Only its own message: nothing from Centralu waits for the child in the hub's mailbox
    expect(hub.store.mailbox.feedOf(addressOf('m1.c1'), { limit: 10 }).map((m) => m.id)).toEqual([r.messageId])
  })

  it('answers not_yours for a session it did not start there, and writes nothing', async () => {
    const { hub, call } = await rig()
    // `m1.c1` is the child's id here: the machine names its own session, and the hub qualifies it with the link's machine
    for (const sessionId of ['c2', 'm1.c1']) {
      expect(await call({ sessionId, text: 'hello' })).toEqual({ ok: false, why: 'not_yours', text: 'Hub mac did not start this session.' })
    }
    expect(hub.store.mailbox.feedOf(addressOf('h1'), { limit: 10 })).toEqual([])
  })

  it('answers its own refusal with the reason and words, and writes nothing more', async () => {
    const { hub, call } = await rig()
    expect(await call({ sessionId: 'c1', text: 'once' })).toMatchObject({ ok: true })
    expect(await call({ sessionId: 'c1', text: 'once' })).toEqual({ ok: false, why: 'repeat', text: expect.stringMatching(/^you sent the same text to h1 less than/) })
    expect(hub.store.mailbox.postsSince(addressOf('m1.c1'), 0)).toBe(1)
    await expect(call({ sessionId: 'c1' })).rejects.toThrow('Not a message this computer reads')
  })

  it('a hub from before it has no such call', async () => {
    const { call } = await rig('before')
    await expect(call({ sessionId: 'c1', text: 'hello' })).rejects.toThrow('Unknown method: hub.mail')
  })
})
