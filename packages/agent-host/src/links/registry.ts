import { createPublicKey, verify } from 'node:crypto'
import { isLocalBuildVersion, isNewerVersion, releaseOf } from '@cc/protocol'

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

/**
 * The registry has no such package, or no such version of it (it answers 404 for both). Its own
 * class because the installer acts on it: a version published before the host-only packages
 * existed is installed from its platform package instead (install.ts)
 */
export class NotPublished extends Error {
  constructor(readonly id: string) {
    super(`${id} is not on the npm registry`)
  }
}

async function getJson(url: string, f: typeof globalThis.fetch, id?: string): Promise<unknown> {
  let res: Response
  try {
    res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    // `fetch failed` and `The operation was aborted` say nothing to the person: name what could not be reached
    const why = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message ?? 'no answer'
    throw new Error(`Could not reach the npm registry (${new URL(url).origin}); check this computer’s network connection: ${why}`)
  }
  if (res.status === 404 && id) throw new NotPublished(id)
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
  const [meta, keys] = await Promise.all([getJson(`${registry}/${name}/${version}`, f, `${name}@${version}`), getJson(`${registry}/-/npm/v1/keys`, f)])
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

/** The version to install on a remote, and, when it is not the hub's own, the sentence that says why */
export type InstallVersion = { version: string; note: string | null }

/**
 * The version a hub puts on a remote (#689). A published release is installed as it is. A local
 * build (`<base>.local.N`) was never published, so the remote gets what it was cut from:
 *
 *   1. `<base>`, when the registry has it *and* it speaks the hub's protocol (`protocolVersion` in
 *      the package's `package.json`; releases before the field existed spoke protocol 1, the only
 *      one so far). A local build that raised the protocol is not the same protocol as its base,
 *      and a remote installed at the base would be refused by the link;
 *   2. else the newest published release that is not newer than `<base>` and has the hub's protocol.
 *
 * Nothing that speaks another protocol is offered. With no such release this throws, saying why.
 */
export async function installVersion(hubVersion: string, protocolVersion: number, opts: RegistryOptions = {}): Promise<InstallVersion> {
  if (!isLocalBuildVersion(hubVersion)) return { version: hubVersion, note: null }
  const base = releaseOf(hubVersion)
  const registry = (opts.registry ?? NPM_REGISTRY).replace(/\/+$/, '')
  const f = opts.fetch ?? globalThis.fetch
  const protocolOf = (m: { protocolVersion?: unknown } | undefined) => (typeof m?.protocolVersion === 'number' ? m.protocolVersion : 1)
  let baseProtocol: number | null = null
  try {
    baseProtocol = protocolOf((await getJson(`${registry}/centralu/${base}`, f, `centralu@${base}`)) as { protocolVersion?: unknown })
    if (baseProtocol === protocolVersion) {
      return { version: base, note: `This computer runs the local build ${hubVersion}, which is not published; installing the release it was cut from, ${base}` }
    }
  } catch (err) {
    if (!(err instanceof NotPublished)) throw err
  }
  const doc = (await getJson(`${registry}/centralu`, f)) as { versions?: Record<string, { protocolVersion?: unknown }> }
  const found = Object.entries(doc?.versions ?? {})
    .filter(([v, m]) => !isLocalBuildVersion(v) && v !== base && !isNewerVersion(v, base) && protocolOf(m) === protocolVersion)
    .map(([v]) => v)
    .sort((a, b) => (isNewerVersion(a, b) ? -1 : isNewerVersion(b, a) ? 1 : 0))[0]
  const why = baseProtocol === null ? `${base} is not published` : `${base} speaks protocol ${baseProtocol}, not this computer’s ${protocolVersion}`
  if (!found) {
    throw new Error(`This computer runs the local build ${hubVersion}, and ${why}; no earlier release with protocol ${protocolVersion} is published either, so there is nothing to install`)
  }
  return { version: found, note: `This computer runs the local build ${hubVersion}, and ${why}; installing ${found}, the newest release before it with protocol ${protocolVersion}` }
}
