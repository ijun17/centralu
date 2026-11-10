import { describe, expect, it } from 'vitest'
import { fakeRegistry } from './fake-registry.test-helpers.js'

/**
 * The fake registry the install and update tests share (#2148). The Windows install suites build one with about 25 packages
 * in their setup, and it packed each with `tar` while holding the worker's event loop, back to back: on a loaded Windows
 * machine that passed the 60 s vitest waits for a worker's messages ("Timeout calling onTaskUpdate"), and the file failed
 * with none of its tests run (measured 17 to 19 s of one hold on this suite beside 12 busy threads).
 */
describe('the fake registry', () => {
  it('packs its tarballs without holding the event loop', async () => {
    let longest = 0
    let last = performance.now()
    let on = true
    const tick = () => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
      if (on) setImmediate(tick)
    }
    setImmediate(tick)
    const t0 = performance.now()
    const reg = await fakeRegistry(Array.from({ length: 8 }, (_, i) => ({ name: 'pkg', version: `1.0.${i}`, files: { 'package.json': JSON.stringify({ name: 'pkg', version: `1.0.${i}` }) } })))
    const end = performance.now()
    const total = end - t0
    // The hold still going when the build returned counts too: held throughout, no tick ran at all
    longest = Math.max(longest, end - last)
    on = false
    await reg.close()
    // Held, the eight runs of tar are one hold as long as all of them together; not held, the loop turns while each one runs, so
    // no hold is near the whole build (one package's share, an eighth; the bound leaves room for a pause under load)
    expect(longest).toBeLessThan(total / 2)
  })
})
