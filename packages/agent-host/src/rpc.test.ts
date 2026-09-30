import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'

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
