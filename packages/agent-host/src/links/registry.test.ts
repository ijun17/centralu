import { afterEach, describe, expect, it } from 'vitest'
import { fakeRegistry, sha512, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installVersion, verifiedPackage } from './registry.js'

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
    reg.forgeSignature('@centralu/linux-x64@9.9.9')
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

describe('installVersion: what a hub puts on a remote (#689)', () => {
  /** A registry that knows these versions of `centralu`, each with the protocol it declares (none: the field did not exist yet) */
  const registry = (versions: Record<string, number | undefined>): { registry: string; fetch: typeof fetch; asked: string[] } => {
    const asked: string[] = []
    const f: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname
      asked.push(path)
      const v = /^\/centralu\/(.+)$/.exec(path)?.[1]
      if (v) return v in versions ? Response.json({ name: 'centralu', version: v, ...(versions[v] === undefined ? {} : { protocolVersion: versions[v] }) }) : new Response('{}', { status: 404 })
      if (path === '/centralu') return Response.json({ versions: Object.fromEntries(Object.entries(versions).map(([k, p]) => [k, p === undefined ? {} : { protocolVersion: p }])) })
      return new Response('{}', { status: 404 })
    }
    return { registry: 'https://registry.test', fetch: f, asked }
  }

  it('a published release is installed as it is, with no question to the registry', async () => {
    const r = registry({})
    expect(await installVersion('0.3.0-beta.7', 1, r)).toEqual({ version: '0.3.0-beta.7', note: null })
    expect(r.asked).toEqual([])
  })

  it('a local build installs its base release, and the note says so', async () => {
    const r = registry({ '0.3.0-beta.7': undefined, '0.3.0-beta.6': undefined })
    const got = await installVersion('0.3.0-beta.7.local.2', 1, r)
    expect(got.version).toBe('0.3.0-beta.7')
    expect(got.note).toMatch(/local build 0\.3\.0-beta\.7\.local\.2.*not published.*0\.3\.0-beta\.7/)
  })

  it('with the base unpublished, takes the newest earlier release with the hub’s protocol', async () => {
    const r = registry({ '0.3.0-beta.5': 1, '0.3.0-beta.6': 1, '0.3.0-beta.4': 1, '0.3.0-beta.8': 1, '0.3.0-beta.7.local.1': 1 })
    const got = await installVersion('0.3.0-beta.7.local.2', 1, r)
    // beta.23 is newer than the base, and a local build is never on the registry's list of releases to use
    expect(got.version).toBe('0.3.0-beta.6')
    expect(got.note).toMatch(/0\.3\.0-beta\.7 is not published; installing 0\.3\.0-beta\.6/)
  })

  it('skips releases that speak another protocol, and refuses when none is left', async () => {
    expect((await installVersion('0.2.0-beta.3.local.1', 2, registry({ '0.2.0-beta.2': 2, '0.2.0-beta.1': 1 }))).version).toBe('0.2.0-beta.2')
    await expect(installVersion('0.2.0-beta.3.local.1', 2, registry({ '0.2.0-beta.2': 1, '0.2.0-beta.1': undefined }))).rejects.toThrow(/0\.2\.0-beta\.3 is not published; no earlier release with protocol 2 is published either/)
  })

  it('a published base that speaks another protocol is not installed: the newest earlier release with the hub’s protocol is, or the refusal says why (#689)', async () => {
    // The local build raised the protocol; the base release (2.x) still speaks the old one
    const got = await installVersion('0.3.0-beta.7.local.2', 2, registry({ '0.3.0-beta.7': 1, '0.3.0-beta.6': 2, '0.3.0-beta.5': 1 }))
    expect(got.version).toBe('0.3.0-beta.6')
    expect(got.note).toMatch(/0\.3\.0-beta\.7 speaks protocol 1, not this computer’s 2; installing 0\.3\.0-beta\.6/)
    await expect(installVersion('0.3.0-beta.7.local.2', 2, registry({ '0.3.0-beta.7': 1, '0.3.0-beta.6': 1 }))).rejects.toThrow(/0\.3\.0-beta\.7 speaks protocol 1, not this computer’s 2; no earlier release with protocol 2/)
    // A base that declares the hub’s protocol is taken as it is
    expect((await installVersion('0.3.0-beta.7.local.2', 2, registry({ '0.3.0-beta.7': 2, '0.3.0-beta.6': 2 }))).version).toBe('0.3.0-beta.7')
  })

  it('a registry that cannot be reached says so, with the address and what to check', async () => {
    const offline: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND registry.test') })
    }
    const err = await installVersion('0.3.0-beta.7.local.2', 1, { registry: 'https://registry.test', fetch: offline }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Could not reach the npm registry (https://registry.test); check this computer’s network connection: getaddrinfo ENOTFOUND registry.test')
    await expect(verifiedPackage('centralu', '9.9.9', { registry: 'https://registry.test', fetch: offline })).rejects.toThrow(/Could not reach the npm registry/)
  })

  it('a registry that answers an error status is passed on', async () => {
    const down: typeof fetch = async () => new Response('', { status: 503 })
    await expect(installVersion('0.3.0-beta.7.local.2', 1, { registry: 'https://registry.test', fetch: down })).rejects.toThrow(/answered 503/)
  })
})
