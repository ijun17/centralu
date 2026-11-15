import { afterEach, describe, expect, it } from 'vitest'
import { TOKEN, cleanups, runCleanups } from './links-world.test-helpers.js'
import { RemoteClient } from './remote-client.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { linkedSessions } from './linked-sessions.js'
import { sessionAddress } from '../mail/address.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The cards of a machine's session, as a hub's session that gave it work reads and answers them (#1948 step 6, docs/plans/mailbox.md §10.6.4): the
 * machine alone judges, by its own rule for its own givers, through `host.cards` and `host.answerCard`. Two real hosts over loopback, the machine's
 * mail delivered as main.ts delivers it.
 */

afterEach(runCleanups)

async function rig() {
  const machine = await machineHost({ sessions: ['w1'], mail: 'delivered' })
  const hub = await hubHost(machine.port, { mail: true })
  await eventually(() => hub.machine().status === 'connected')
  await eventually(() => machine.hubs.mailHubs()[0]?.you === 'm1' && hub.links.get('m1')?.takesTasks === true)
  const reader = linkedSessions(() => hub.links.all(), (method, params) => hub.router.handle(method, params))
  const send = async (from: string, text: string) => {
    const sent = await hub.mail!.across.sendTask(from, sessionAddress(hub.id, 'm1.w1'), text, { origin: 'agent_session' })
    if (!sent.ok) throw new Error(sent.text)
    return sent.messageId
  }
  const standing = () => machine.mgr.listSessions().find((s) => s.id === 'w1')!
  const cards = async (caller: string) => {
    const r = await reader.cards('m1.w1', caller)
    if (!r.ok) throw new Error(r.error)
    return r.cards
  }
  return { machine, hub, reader, send, standing, cards }
}

describe("a machine's cards, as a hub's giver of work there reads them (#1948 step 6)", () => {
  it("never the person's: a question their own turn raised stays theirs, though the hub's task to the session waits there unsettled", async () => {
    const { machine, reader, send, standing, cards } = await rig()
    await machine.mgr.inputs.send('w1', 'a question of my own')
    await eventually(() => standing().pendingQuestions.length === 1)
    const requestId = standing().pendingQuestions[0]!.requestId
    // The hub's task, held while the person's turn runs: the newest unsettled task to the session, and not delivered
    await send('h1', 'review the branch')
    expect(await cards('h1')).toEqual([])
    const answered = await reader.answerCard('m1.w1', 'h1', `x:${requestId}`, 'Yes')
    expect(answered).toMatchObject({ ok: false, error: expect.stringContaining('no work of yours open') })
    expect(standing().pendingQuestions.map((q) => q.requestId)).toEqual([requestId])
  })

  it('answers a question raised in the turn its task started there; another hub session, and the old giver after a handoff, may not', async () => {
    const { machine, hub, reader, send, standing, cards } = await rig()
    const id = await send('h1', 'a question for the hub')
    await eventually(() => standing().pendingQuestions.length === 1)
    expect(await cards('h2')).toEqual([])
    const [card] = await cards('h1')
    expect(card).toMatchObject({ kind: 'question', answerable: true, questions: [expect.objectContaining({ question: 'Proceed?' })] })
    // Handed over on the hub: the heir answers, the old giver no longer does
    hub.mail!.service.handOver(sessionAddress(hub.id, 'h1'), sessionAddress(hub.id, 'h2'), 'all', [sessionAddress(hub.id, 'm1.w1')])
    await hub.mail!.across.movedAcross(hub.mail!.service.takeMoves())
    await eventually(() => machine.store.mailbox.message(id)?.sender === sessionAddress(hub.id, 'h2'))
    expect(await cards('h1')).toEqual([])
    expect(await reader.answerCard('m1.w1', 'h1', card!.card, 'Yes')).toMatchObject({ ok: false })
    const [heirs] = await cards('h2')
    expect(heirs).toMatchObject({ kind: 'question', answerable: true })
    expect(await reader.answerCard('m1.w1', 'h2', heirs!.card, 'Yes')).toEqual({ ok: true })
    await eventually(() => standing().pendingQuestions.length === 0)
  })

  it('never answers an approval there, though its task started the turn', async () => {
    const { reader, send, standing, cards } = await rig()
    await send('h1', 'please approve my command')
    await eventually(() => standing().pendingApproval !== null && standing().pendingApproval !== undefined)
    const [card] = await cards('h1')
    expect(card).toMatchObject({ kind: 'approval', answerable: false })
    expect(await reader.answerCard('m1.w1', 'h1', card!.card, 'allow')).toMatchObject({ ok: false, error: expect.stringContaining('Only the person') })
    expect(standing().pendingApproval).toBeTruthy()
  })

  it('are read and answered only from a hub that offered on the same connection: another connection, with the full token, is refused', async () => {
    const { machine, send, standing } = await rig()
    await send('h1', 'a question for the hub')
    await eventually(() => standing().pendingQuestions.length === 1)
    const requestId = standing().pendingQuestions[0]!.requestId
    // A connection with the full token that never offered as a hub
    let hello = false
    const other = new RemoteClient({ url: `ws://127.0.0.1:${machine.port}`, token: TOKEN, maxBackoffMs: 100 }, { hello: () => void (hello = true) })
    cleanups.push(() => other.close())
    other.connect()
    await eventually(() => hello)
    await expect(other.call('host.cards', { sessionId: 'w1', caller: 'h1' })).rejects.toThrow('Only a hub that offered on this connection reads')
    await expect(other.call('host.answerCard', { sessionId: 'w1', caller: 'h1', card: `x:${requestId}`, text: 'Yes' })).rejects.toThrow('Only a hub that offered on this connection answers')
    expect(standing().pendingQuestions.map((q) => q.requestId)).toEqual([requestId])
  })

  it('a machine from before the calls is named as needing an update', async () => {
    const machine = await machineHost({ sessions: ['w1'], mail: true, without: ['host.cards', 'host.answerCard'] })
    const hub = await hubHost(machine.port, { mail: true })
    await eventually(() => hub.machine().status === 'connected')
    const reader = linkedSessions(() => hub.links.all(), (method, params) => hub.router.handle(method, params))
    expect(await reader.cards('m1.w1', 'h1')).toEqual({ ok: false, error: 'Remote box runs an older Centralu, which takes no work from this computer. Update Centralu on Remote box.' })
    expect(await reader.answerCard('m1.w1', 'h1', 'c', 'Yes')).toEqual({ ok: false, error: 'Remote box runs an older Centralu, which takes no work from this computer. Update Centralu on Remote box.' })
  })
})
