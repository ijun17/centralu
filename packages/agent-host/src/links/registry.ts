import { createPublicKey, verify } from 'node:crypto'

/**
 * What the hub reads from the npm registry before it installs a version on a remote
 * (docs/plans/remote-hub.md §10.3): the version's metadata, with its `dist.signatures` checked
 * against the registry's published keys, the way `npm audit signatures` checks them. The remote
 * then checks the tarball's bytes against the `integrity` this answers, a value that did not travel
 * with the file.
 */

export const NPM_REGISTRY = 'https://registry.npmjs.org'

/** One package version as the remote fetches and checks it */
export type VerifiedPackage = { name: string; version: string; tarball: string; integrity: string }

export type RegistryOptions = {
  /** The registry's address. Tests serve one on loopback */
  registry?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

type RegistryKey = { keyid: string; key: string; expires: string | null }

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

async function getJson(url: string, f: typeof globalThis.fetch): Promise<unknown> {
  const res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`The npm registry answered ${res.status} for ${url}`)
  return res.json()
}

/**
 * `name@version` from the registry, refused unless one of its signatures checks out with a
 * registry key that has not expired, over exactly `<name>@<version>:<integrity>` (what npm signs).
 * The tarball must come from the registry itself, and the integrity must be a sha512.
 */
export async function verifiedPackage(name: string, version: string, opts: RegistryOptions = {}): Promise<VerifiedPackage> {
  if (!PACKAGE_NAME.test(name) || !VERSION.test(version)) throw new Error(`Not a package to install: ${name}@${version}`)
  const registry = (opts.registry ?? NPM_REGISTRY).replace(/\/+$/, '')
  const f = opts.fetch ?? globalThis.fetch
  const now = opts.now?.() ?? Date.now()
  const [meta, keys] = await Promise.all([getJson(`${registry}/${name}/${version}`, f), getJson(`${registry}/-/npm/v1/keys`, f)])
  const m = meta as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown; signatures?: unknown } }
  if (m?.name !== name || m.version !== version) throw new Error(`The npm registry answered for another package than ${name}@${version}`)
  const tarball = m.dist?.tarball
  const integrity = m.dist?.integrity
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error(`${name}@${version} has no sha512 integrity in the registry`)
  }
  if (typeof tarball !== 'string' || new URL(tarball).origin !== new URL(registry).origin) {
    throw new Error(`${name}@${version}'s tarball is not served by the registry (${String(tarball)})`)
  }
  const known = new Map<string, RegistryKey>()
  for (const k of ((keys as { keys?: unknown })?.keys ?? []) as RegistryKey[]) {
    if (k && typeof k.keyid === 'string' && typeof k.key === 'string') known.set(k.keyid, k)
  }
  const signed = `${name}@${version}:${integrity}`
  const sigs = Array.isArray(m.dist?.signatures) ? (m.dist.signatures as { keyid?: unknown; sig?: unknown }[]) : []
  const ok = sigs.some((s) => {
    const key = typeof s?.keyid === 'string' ? known.get(s.keyid) : undefined
    if (!key || typeof s.sig !== 'string') return false
    if (key.expires && Date.parse(key.expires) <= now) return false
    try {
      const pub = createPublicKey({ key: Buffer.from(key.key, 'base64'), format: 'der', type: 'spki' })
      return verify('sha256', Buffer.from(signed), pub, Buffer.from(s.sig, 'base64'))
    } catch {
      return false
    }
  })
  if (!ok) throw new Error(`The npm registry's signature on ${name}@${version} does not check out; nothing was installed`)
  return { name, version, tarball, integrity }
}
