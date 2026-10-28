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

  it('says whether a linked hub stops it for an update, so the turns it ends are listed for the next host (#1618)', async () => {
    const asked: { forUpdate: boolean }[] = []
    const rpc = await handler({ stopHost: (o) => void asked.push(o) })
    await rpc('host.stop', { forUpdate: true })
    await rpc('host.stop', {})
    await new Promise((r) => setTimeout(r, 100))
    expect(asked).toEqual([{ forUpdate: true }, { forUpdate: false }])
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

/** The person's answers to the limited credential's calls (#1405, host-requests.ts), as the window reaches them */
describe('requests.list and requests.answer', () => {
  const handler = (services: Parameters<typeof createRpcHandler>[2]) => createRpcHandler({} as SessionManager, new Map(), services)
  const request = { requestId: 'r1', method: 'trash.purge', question: 'Delete "x" for good?', client: null, createdAt: 1, expiresAt: 2 }

  it('lists what waits and passes the answer on, checking its shape first', async () => {
    const answered: [string, string][] = []
    const rpc = handler({ requests: { list: () => [request], answer: (id, d) => (answered.push([id, d]), id === 'r1') } })
    await expect(rpc('requests.list', {})).resolves.toEqual([request])
    await expect(rpc('requests.answer', { requestId: 'r1', decision: 'allow' })).resolves.toEqual({ ok: true })
    await expect(rpc('requests.answer', { requestId: 'gone', decision: 'deny' })).resolves.toEqual({ ok: false })
    await expect(rpc('requests.answer', { requestId: 'r1', decision: 'always' })).rejects.toThrow()
    expect(answered).toEqual([['r1', 'allow'], ['gone', 'deny']])
  })

  it('has nothing waiting on a host without the service, and answers nothing', async () => {
    const rpc = handler({})
    await expect(rpc('requests.list', {})).resolves.toEqual([])
    await expect(rpc('requests.answer', { requestId: 'r1', decision: 'allow' })).resolves.toEqual({ ok: false })
  })
})

/** Every tool's setup in one shape (#59, owner 2026-10-27: the header's donut for each tool installed but signed out) */
describe('agents.detect and the setup actions', () => {
  const adapter = (name: string, found: { installed: boolean; loggedIn: boolean }, setup?: unknown) =>
    ({
      tool: name,
      descriptor: { name, label: name.toUpperCase(), mark: name[0], install: `install ${name}`, login: `login ${name}` },
      detect: async () => ({ tool: name, ...found, detail: '' }),
      ...(setup ? { setup } : {}),
    }) as never

  it('reports installed-but-signed-out for a tool that signs in from a terminal, and ready, and not installed', async () => {
    const adapters = new Map([
      ['t1', adapter('t1', { installed: true, loggedIn: false })],
      ['t2', adapter('t2', { installed: true, loggedIn: true })],
      ['t3', adapter('t3', { installed: false, loggedIn: false })],
    ])
    const rpc = createRpcHandler({} as SessionManager, adapters, {})
    const found = (await rpc('agents.detect', {})) as { name: string; setup: { state: string; signIn: string } }[]
    expect(found.map((t) => [t.name, t.setup.state, t.setup.signIn])).toEqual([
      ['t1', 'signed_out', 'terminal'],
      ['t2', 'ready', 'terminal'],
      ['t3', 'not_installed', 'terminal'],
    ])
    expect(found.every((t) => RpcMethods['agents.detect'].result.safeParse([t]).success)).toBe(true)
  })

  it("passes the install and sign-in to the tool's own setup, and refuses them for a tool that has none", async () => {
    const calls: string[] = []
    const setup = { state: 'installing', install: 'centralu', signIn: 'centralu' }
    const control = {
      current: () => setup,
      install: () => (calls.push('install'), setup),
      cancelInstall: async () => (calls.push('cancelInstall'), setup),
      signIn: () => (calls.push('signIn'), setup),
      cancelSignIn: async () => (calls.push('cancelSignIn'), setup),
      onChange: () => () => {},
    }
    const rpc = createRpcHandler({} as SessionManager, new Map([['own', adapter('own', { installed: false, loggedIn: false }, control)], ['term', adapter('term', { installed: true, loggedIn: true })]]), {})
    for (const m of ['agents.installTool', 'agents.cancelInstallTool', 'agents.signIn', 'agents.cancelSignIn'] as const) await expect(rpc(m, { tool: 'own' })).resolves.toEqual(setup)
    expect(calls).toEqual(['install', 'cancelInstall', 'signIn', 'cancelSignIn'])
    await expect(rpc('agents.installTool', { tool: 'term' })).rejects.toThrow(/from a terminal/)
    await expect(rpc('agents.signIn', { tool: 'nope' })).rejects.toThrow(/Unknown tool/)
  })
})
