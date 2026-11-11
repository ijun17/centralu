import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf as addr, wireHostMail } from './host-mail.test-helpers.js'

/**
 * #2164: a child that calls compact_self with a next step ends its turn, Centralu compacts the conversation, and the step goes in as a
 * turn of the child's own. That turn goes on with the work its caller gave, as the turn a paused report's work starts does (#1576): the
 * caller's note goes into it, and its end is reported to the caller. Before, the note was refused as a turn the caller had not given
 */
describe("the turn a compaction's next step opens in a child (#2164)", () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(() => w.dispose())

  const reportsTo = (caller: string, child: string) =>
    w.store.messages.loadMessages(caller, 200).filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId?: string } }).from?.sessionId === child)

  /** A child of the caller's that asked to compact, with a next step, in the turn the caller gave it; that turn has ended and been reported */
  async function compacting() {
    const caller = await w.callerSession()
    const r = await w.mgr.startAgent(caller, { task: 'fix it', tool: 'claude', wait: false })
    if (!r.ok || r.state !== 'working') throw new Error(JSON.stringify(r))
    const child = r.sessionId
    const h = w.adapters.get('claude')!.handles.get(child)!
    h.event({ type: 'context_update', sessionId: child, used: 150_000, window: 200_000, exactness: 'exact' })
    h.opts.centraluTools!.compactSelf!(undefined, 'Go on with step 3')
    h.answer('Compacting first.')
    await w.until(() => reportsTo(caller, child).length === 1 && h.sent.includes('/compact'))
    return { caller, child, h }
  }

  it("takes the caller's note into it, and reports its end to the caller", async () => {
    const { caller, child, h } = await compacting()
    // The compact turn: the tool reports the compaction in it, and it ends; the step goes in and opens the next turn
    h.event({ type: 'compaction', sessionId: child, failed: false })
    h.event({ type: 'turn_complete', sessionId: child })
    await w.until(() => h.sent.some((t) => t.includes('Go on with step 3')))
    const sent = await w.mgr.agentSession(caller, { sessionId: child, action: 'send', text: 'use staging', ifBusy: 'note' })
    expect(sent).toMatchObject({ ok: true })
    expect(h.sent.join(' ')).toContain('use staging')
    h.answer('Step 3 done.')
    await w.until(() => reportsTo(caller, child).length === 2)
    expect(String((reportsTo(caller, child)[1]!.payload as { text?: string }).text)).toContain('Step 3 done.')
  })

  it('takes no mail into the compact turn: the mail goes once that turn ends (docs/plans/mailbox.md §10.6.2)', async () => {
    const { caller, child, h } = await compacting()
    // Mail from here on: the compact turn runs
    const clock = { t: Date.now() }
    const m = wireHostMail(w.mgr, w.store, { now: () => clock.t })
    m.delivery.start()
    try {
      h.acceptsAtOnce = true
      const sent = m.service.send(addr(caller), { to: [addr(child)], text: 'also check the docs' })
      clock.t += 3_000
      await m.delivery.process(addr(child))
      expect(h.sent.join(' ')).not.toContain(sent.message.id)
      expect(w.store.mailbox.recipient(sent.message.id, addr(child))?.deliveredAt).toBeNull()
      h.event({ type: 'compaction', sessionId: child, failed: false })
      h.event({ type: 'turn_complete', sessionId: child })
      // Its end pokes the delivery: the mail goes now, as a turn of its own
      await w.until(() => h.sent.join(' ').includes(sent.message.id) && w.store.mailbox.recipient(sent.message.id, addr(child))?.deliveredAt != null)
    } finally {
      m.delivery.stop()
    }
  })

  it("is the caller's no longer once the person writes: a note into their turn is refused", async () => {
    const { caller, child, h } = await compacting()
    h.event({ type: 'compaction', sessionId: child, failed: false })
    h.event({ type: 'turn_complete', sessionId: child })
    await w.until(() => h.sent.some((t) => t.includes('Go on with step 3')))
    h.answer('Step 3 done.')
    await w.until(() => reportsTo(caller, child).length === 2)
    // The person writes next: their turn is not the work's, and a later turn of the child's own is not either
    await w.mgr.inputs.send(child, 'my own thing')
    const r = await w.mgr.agentSession(caller, { sessionId: child, action: 'send', text: 'use staging', ifBusy: 'note' })
    expect(r).toMatchObject({ ok: false })
    expect(h.sent.join(' ')).not.toContain('use staging')
  })
})
