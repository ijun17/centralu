import { afterEach, describe, expect, it } from 'vitest'
import { fakeRegistry, sha512, type FakeRegistry } from './fake-registry.test-helpers.js'
import { verifiedPackage } from './registry.js'

/**
 * The hub's half of the trust in plan §10.3: the integrity the remote checks the tarball against
 * comes from version metadata whose registry signature checked out here.
 */

let reg: FakeRegistry | null = null
afterEach(async () => {
  await reg?.close()
  reg = null
})

const files = { 'package.json': '{"name":"centralu","version":"9.9.9"}', 'bin/centralu.mjs': 'console.log(1)\n' }

describe('verifiedPackage (#82, plan §10.3)', () => {
  it('answers the tarball and integrity of a version whose signature checks out', async () => {
    reg = await fakeRegistry([{ name: 'centralu', version: '9.9.9', files }])
    const p = await verifiedPackage('centralu', '9.9.9', { registry: reg.url })
    expect(p).toEqual({ name: 'centralu', version: '9.9.9', tarball: `${reg.url}/centralu/-/centralu-9.9.9.tgz`, integrity: expect.stringMatching(/^sha512-/) })
    expect(sha512(Buffer.from(await (await fetch(p.tarball)).arrayBuffer()))).toBe(p.integrity)
  })

  it('refuses metadata signed by a key the registry does not publish', async () => {
    reg = await fakeRegistry([{ name: '@centralu/linux-x64', version: '9.9.9', files }])
    reg.forgeSignature('@centralu/linux-x64')
    await expect(verifiedPackage('@centralu/linux-x64', '9.9.9', { registry: reg.url })).rejects.toThrow(/signature on @centralu\/linux-x64@9\.9\.9 does not check out/)
  })

  it('refuses a signature made with a key that has expired', async () => {
    reg = await fakeRegistry([{ name: 'centralu', version: '9.9.9', files }])
    const real = globalThis.fetch
    const expired: typeof fetch = async (url, init) => {
      const res = await real(url, init)
      if (!String(url).endsWith('/-/npm/v1/keys')) return res
      const body = (await res.json()) as { keys: { expires: string | null }[] }
      for (const k of body.keys) k.expires = '2020-01-01T00:00:00.000Z'
      return new Response(JSON.stringify(body))
    }
    await expect(verifiedPackage('centralu', '9.9.9', { registry: reg.url, fetch: expired })).rejects.toThrow(/does not check out/)
  })

  it('refuses a name or version that is not a plain word, before asking anything', async () => {
    await expect(verifiedPackage('centralu', '../../x')).rejects.toThrow(/Not a package to install/)
    await expect(verifiedPackage('a b', '1.0.0')).rejects.toThrow(/Not a package to install/)
  })
})
