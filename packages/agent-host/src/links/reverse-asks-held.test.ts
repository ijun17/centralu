import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_CALL_METHOD, HoldCallParams } from '@cc/protocol'
import { runCleanups } from './links-world.test-helpers.js'
import { rig } from './reverse-link.test-helpers.js'
import { RemoteClient } from './remote-client.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * A linked machine's ask waits on the hub's card for the pair (#550). While the person cannot see that card (their own
 * turn in the session cleared the slot until it ends, #673, or another card stands there) the hub holds the ask's limit
 * on the machine (`call.hold`, #2271), so the remote work is not refused unseen. A held ask still ends when the link
 * goes, when the machine withdraws it, and past the bound on holding. Real hosts in one process, linked over loopback.
 */

/** The holds the hub said and the machine answered, in order (`call.hold`): a test waits on what the machine has taken, not on time */
const told: boolean[] = []
const held = () => told.at(-1) === true

beforeEach(() => {
  told.length = 0
  const call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(function (this: RemoteClient, method, params, timeoutMs) {
    const answer = call.call(this, method, params, timeoutMs)
    if (method === HOLD_CALL_METHOD) answer.then(() => told.push(HoldCallParams.parse(params).held), () => undefined)
    return answer
  })
})
afterEach(async () => {
  await runCleanups()
  vi.restoreAllMocks()
})

/** The ask's limit on the machine: short, so a test outlasts it, and wide enough that raising the card fits in it under load */
const LIMIT = 1000 * SLOW

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Whether a promise has settled yet */
function settledFlag(p: Promise<unknown>): () => boolean {
  let settled = false
  void p.then(
    () => void (settled = true),
    () => void (settled = true),
  )
  return () => settled
}

describe("a linked machine's ask whose card the person cannot see (#2271)", () => {
  it('waits out a turn of the person longer than its limit, and is answered once the card comes back', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: LIMIT })
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    const settled = settledFlag(call)
    await eventually(() => !!hub.card())
    // The person works in that session: the card leaves the slot for the length of their turn
    await hub.mgr.inputs.send('h1', 'a long job of my own')
    await eventually(() => !hub.card() && hub.mgr.listSessions().find((s) => s.id === 'h1')?.state === 'working')
    await eventually(held)
    await delay(2 * LIMIT)
    expect(settled()).toBe(false)
    hub.finish('h1', 'done with mine')
    // Raised again at the turn's end (#673); the limit runs on with what it had left
    await hub.answer('allow')
    expect(await call).toMatchObject({ ok: true, state: 'done' })
  }, 30_000 * SLOW)

  it('waits while another card stands in the slot, and comes up when that one is answered', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: LIMIT })
    await hub.mgr.inputs.send('h1', 'please approve my command')
    const own = (await eventually(() => hub.card()))!
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    const settled = settledFlag(call)
    await eventually(() => hub.mgr.hostCards.hostAsks.size === 1)
    await eventually(held)
    await delay(2 * LIMIT)
    expect(settled()).toBe(false)
    expect(hub.card()?.requestId).toBe(own.requestId)
    hub.mgr.inputs.respondApproval('h1', own.requestId, 'allow')
    await eventually(() => hub.card()?.requestId !== own.requestId && !!hub.card())
    await hub.answer('allow')
    expect(await call).toMatchObject({ ok: true, state: 'done' })
  }, 30_000 * SLOW)

  it('ends at once when the link goes while the card is held', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: LIMIT })
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    const settled = settledFlag(call)
    await eventually(() => !!hub.card())
    await hub.mgr.inputs.send('h1', 'a long job of my own')
    await eventually(() => !hub.card())
    // Held past its limit
    await eventually(held)
    await delay(2 * LIMIT)
    expect(settled()).toBe(false)
    await hub.stop()
    // The link's end answers the held call
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('could not be asked') })
  }, 30_000 * SLOW)

  it('ends when the machine withdraws it while held, and the hub forgets the card', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: LIMIT })
    const stop = new AbortController()
    const call = machine.ask({ project: hub.projectName, task: 'say hello' }, stop.signal)
    const settled = settledFlag(call)
    await eventually(() => !!hub.card())
    await hub.mgr.inputs.send('h1', 'a long job of my own')
    await eventually(() => !hub.card())
    // Held past its limit
    await eventually(held)
    await delay(2 * LIMIT)
    expect(settled()).toBe(false)
    stop.abort()
    expect(await call).toMatchObject({ ok: false, error: 'The call was cancelled.' })
    await eventually(() => hub.mgr.hostCards.hostAsks.size === 0)
  }, 30_000 * SLOW)

  it('is not held past the bound: the ask then ends as one that ran out of time, and its card is withdrawn', async () => {
    const { machine, hub } = await rig({ askTimeoutMs: 120_000 * SLOW, askHoldMaxMs: LIMIT })
    const call = machine.ask({ project: hub.projectName, task: 'say hello' })
    await eventually(() => !!hub.card())
    await hub.mgr.inputs.send('h1', 'a long job of my own')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('held hub.askProject longer than') })
    await eventually(() => hub.mgr.hostCards.hostAsks.size === 0)
    hub.finish('h1', 'done with mine')
    await eventually(() => hub.mgr.listSessions().find((s) => s.id === 'h1')?.state === 'waiting_input')
    expect(hub.card()).toBeFalsy()
  }, 30_000 * SLOW)
})
