import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'
import { createRpcHandler } from './rpc.js'
import { Drain, DrainCut } from './drain.js'
import { createStopGate } from './lifecycle/stop-gate.js'
import type { SessionManager } from './sessions/manager.js'

/**
 * Checks that a settings field does not silently disappear at the RPC boundary.
 *
 * When effort was added, rpc.ts was pulling fields out one by one and that one got left out. The
 * UI sent it but it never reached the host, and **nothing happened, with no error** — the worst
 * kind of failure to track down, because the screen looks like it changed.
 *
 * So this pins down "the handler does not pull fields out one by one." Passing the object through
 * whole means this spot never needs fixing again as more settings are added.
 */
describe('agents.updateSettings — no field leaks', () => {
  it('the settings fields the schema knows about', () => {
    const shape = Object.keys(RpcMethods['agents.updateSettings'].params.shape)
    expect(shape.sort()).toEqual(['by', 'effort', 'model', 'permissionPreset', 'serviceTier', 'sessionId', 'verbosity'])
  })

  it('the handler strips only sessionId and passes the rest through whole', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./rpc.ts', import.meta.url), 'utf8'),
    )
    const handler = /'agents\.updateSettings':[\s\S]*?\n {4}\},/.exec(src)?.[0] ?? ''
    expect(handler, 'could not find the updateSettings handler').toBeTruthy()

    // Listing fields one by one would let this spot silently drop each new setting as it is added
    expect(handler).toMatch(/\.\.\.settings/)
    expect(handler).not.toMatch(/\{\s*sessionId,\s*model,/)
  })
})

/**
 * `host.stop` (`centralu serve --stop`, docs/agent-host.md §4.7): a serve-started host ends itself in
 * order once the answer is out; a host under the app's keeper refuses, since the app stops it and the
 * keeper would only start it again.
 */
describe('host.stop', () => {
  const handler = async (services: Parameters<typeof createRpcHandler>[2]) =>
    createRpcHandler({} as SessionManager, new Map(), services)

  it('answers first, then stops the host it was given', async () => {
    let stopped = 0
    const rpc = await handler({ stopHost: () => void stopped++ })
    await expect(rpc('host.stop', {})).resolves.toEqual({ ok: true })
    expect(stopped).toBe(0)
    await new Promise((r) => setTimeout(r, 100))
    expect(stopped).toBe(1)
  })

  it('is refused by a host with nothing to stop it through (one the app runs)', async () => {
    const rpc = await handler({})
    await expect(rpc('host.stop', {})).rejects.toThrow(/quit the app instead/)
  })

  /*
   * #1224's review: the hand-over into the Windows sign-in asked the activity, then stopped, over two calls; a turn the
   * hub started in between was ended with the host. `ifIdle` checks and acts in one step on the host, counting calls in
   * flight (one may be about to start a turn), and from its yes on refuses every new call
   */
  const idle = { working: 0, approvals: 0, questions: 0, background: 0, terminals: 0, commandRuns: 0 }

  it('with ifIdle, a call in flight or work running makes it answer busy and stop nothing; idle, it stops and no turn can start after', async () => {
    const drain = new Drain()
    let activity = { ...idle }
    let stopped = 0
    const rpc = await handler({ stopHost: () => void stopped++, stopGate: createStopGate({ drain, activity: () => activity }) })
    // As the transport runs every call: tracked by the drain
    const call = (method: string, params: unknown) => drain.track(`rpc ${method}`, () => rpc(method, params))

    // A send arrived first and has not started its turn yet
    let release = () => {}
    const send = drain.track('rpc sessions.send', () => new Promise<void>((r) => (release = r)))
    await expect(call('host.stop', { ifIdle: true })).resolves.toEqual({ ok: false, busy: idle, calls: 1 })
    release()
    await send
    // Its turn runs now
    activity = { ...idle, working: 1 }
    await expect(call('host.stop', { ifIdle: true })).resolves.toEqual({ ok: false, busy: { ...idle, working: 1 }, calls: 0 })
    // An open terminal counts as much as a turn
    activity = { ...idle, terminals: 1 }
    await expect(call('host.stop', { ifIdle: true })).resolves.toMatchObject({ ok: false })
    await new Promise((r) => setTimeout(r, 100))
    expect(stopped).toBe(0)

    activity = { ...idle }
    await expect(call('host.stop', { ifIdle: true })).resolves.toEqual({ ok: true })
    // The turn the hub starts now is refused, as retryable, instead of being cut by the stop
    await expect(drain.track('rpc sessions.send', async () => 'started')).rejects.toBeInstanceOf(DrainCut)
    await new Promise((r) => setTimeout(r, 100))
    expect(stopped).toBe(1)
  })

  it('without ifIdle stops as before, whatever runs; with ifIdle and no way to tell, it refuses', async () => {
    let stopped = 0
    const rpc = await handler({ stopHost: () => void stopped++, stopGate: createStopGate({ drain: new Drain(), activity: () => ({ ...idle, working: 3 }) }) })
    await expect(rpc('host.stop', {})).resolves.toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 100))
    expect(stopped).toBe(1)
    const blind = await handler({ stopHost: () => void stopped++ })
    await expect(blind('host.stop', { ifIdle: true })).rejects.toThrow(/cannot tell whether it is idle/)
  })

  it('keeps what a sign-in’s serve says about taking over (host.handover)', async () => {
    const said: unknown[] = []
    const rpc = await handler({ handover: (h) => void said.push(h) })
    await expect(rpc('host.handover', { handover: { state: 'waiting', since: 5 } })).resolves.toEqual({ ok: true })
    await expect(rpc('host.handover', { handover: null })).resolves.toEqual({ ok: true })
    expect(said).toEqual([{ state: 'waiting', since: 5 }, null])
  })
})

/** #841 item 7: the processes the keeper holds are never offered as leftovers, even when it cannot say which they are */
describe('processes.strays', () => {
  const mgr = { folderRoots: () => ['/nowhere'] } as unknown as SessionManager
  it('refuses to list when the keeper cannot say which processes it holds', async () => {
    const rpc = createRpcHandler(mgr, new Map(), { heldPids: () => Promise.reject(new Error('keeper gone')) })
    await expect(rpc('processes.strays', {})).rejects.toThrow(/keeper could not say/)
    await expect(rpc('processes.stop', { pids: [12345] })).rejects.toThrow(/keeper could not say/)
  })
})
