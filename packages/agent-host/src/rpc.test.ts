import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'
import { createRpcHandler } from './rpc.js'
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
    expect(shape.sort()).toEqual(['effort', 'model', 'permissionPreset', 'serviceTier', 'sessionId', 'verbosity'])
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
})
