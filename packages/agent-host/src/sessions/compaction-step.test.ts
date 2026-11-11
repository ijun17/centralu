import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import type { HostMail } from '../mail/host-mail.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'

/**
 * #2164: a child that calls compact_self with a next step ends its turn, Centralu compacts the conversation, and the step goes in as a
 * turn of the child's own. That turn goes on with the work its caller gave: its last response answers the caller's task (docs/plans/mailbox.md §10.6.3)
 */
describe("the turn a compaction's next step opens in a child (#2164)", () => {
  let w: CrossWorld
  let m: HostMail
  const clock = { t: 0 }
  beforeEach(async () => {
    w = await crossWorld()
    clock.t = Date.now()
    m = wireHostMail(w.mgr, w.store, { now: () => clock.t })
    m.delivery.start()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    m.delivery.stop()
    await w.dispose()
  })

  /** Centralu's reports on the tasks the caller gave the child, oldest first */
  const reportsTo = (caller: string, child: string) => {
    const read = mailReader(w.store)
    return read.tasks(addr(caller), child).flatMap((t) => read.reportsOn(t.id))
  }

  /** A child of the caller's that asked to compact, with a next step, in the turn the caller gave it; that turn has ended */
  async function compacting() {
    const caller = await w.callerSession()
    const r = await w.mgr.startAgent(caller, { task: 'fix it', tool: 'claude', wait: false })
    if (!r.ok || r.state !== 'working') throw new Error(JSON.stringify(r))
    const child = r.sessionId
    const h = w.adapters.get('claude')!.handles.get(child)!
    h.event({ type: 'context_update', sessionId: child, used: 150_000, window: 200_000, exactness: 'exact' })
    h.opts.centraluTools!.compactSelf!(undefined, 'Go on with step 3')
    h.answer('Compacting first.')
    await w.until(() => h.sent.includes('/compact'))
    return { caller, child, h }
  }

  it("answers the caller's task with its last response, once: neither the turn that asked to compact nor the compact turn does", async () => {
    const { caller, child, h } = await compacting()
    // The turn that asked to compact is not at rest: Centralu goes on with the work's next step
    // The compact turn: the tool reports the compaction in it, and it ends; the step goes in and opens the next turn
    h.event({ type: 'compaction', sessionId: child, failed: false })
    h.event({ type: 'turn_complete', sessionId: child })
    await w.until(() => h.sent.some((t) => t.includes('Go on with step 3')))
    h.answer('Step 3 done.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    expect(reportsTo(caller, child).map((r) => r.facts.answer)).toEqual(['Step 3 done.'])
  })

  it('a call waiting on the child does not take the turn that asked to compact as the answer: it says "working", and the step\'s turn answers', async () => {
    const caller = await w.callerSession()
    const call = w.mgr.startAgent(caller, { task: 'fix it', tool: 'claude' })
    const handle = () => [...w.adapters.get('claude')!.handles.values()].find((x) => w.mgr.sessionInfo(x.sessionId)?.askedBy === caller)
    await w.until(() => !!handle()?.sent.length)
    const h = handle()!
    const child = h.sessionId
    h.event({ type: 'context_update', sessionId: child, used: 150_000, window: 200_000, exactness: 'exact' })
    h.opts.centraluTools!.compactSelf!(undefined, 'Go on with step 3')
    h.answer('Compacting first.')
    expect(await call).toMatchObject({ ok: true, state: 'working', sessionId: child })
    expect(reportsTo(caller, child)).toEqual([])
    await w.until(() => h.sent.includes('/compact'))
    h.event({ type: 'compaction', sessionId: child, failed: false })
    h.event({ type: 'turn_complete', sessionId: child })
    await w.until(() => h.sent.some((t) => t.includes('Go on with step 3')))
    h.answer('Step 3 done.')
    await w.until(() => reportsTo(caller, child).length > 0)
    expect(reportsTo(caller, child).map((r) => r.facts.answer)).toEqual(['Step 3 done.'])
  })

  it('takes no mail into the compact turn: the mail goes once that turn ends (docs/plans/mailbox.md §10.6.2)', async () => {
    const { caller, child, h } = await compacting()
    // Mail from here on: the compact turn runs
    {
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
    }
  })
})
