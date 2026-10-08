import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A local stand-in for registry.npmjs.org and nodejs.org/dist (links/install tests): signed version
 * metadata, the registry's keys, package tarballs, and Node archives, all built here with the
 * system's `tar`. What it serves can be tampered with per test.
 */

export type FakeFile = string | { text: string; mode: number }
export type FakePackage = { name: string; version: string; files: Record<string, FakeFile> }

/** A `.tar.gz` of `files` under `top/`, as npm packs (`package/`) and Node ships (`node-v…/`) */
export function tarGz(top: string, files: Record<string, FakeFile>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fake-tar-'))
  try {
    for (const [path, f] of Object.entries(files)) {
      const file = join(dir, top, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, typeof f === 'string' ? f : f.text)
      if (typeof f !== 'string') chmodSync(file, f.mode)
    }
    execFileSync('tar', ['-czf', join(dir, 'out.tgz'), '-C', dir, top])
    return readFileSync(join(dir, 'out.tgz'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const sha512 = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export type FakeRegistry = {
  url: string
  /** Requests served, by path */
  hits: string[]
  /** Serves these bytes for `name@version`'s tarball in place of what its integrity names */
  swapTarball(id: string, bytes: Buffer): void
  /** Signs `name@version`'s metadata with a key the registry does not publish */
  forgeSignature(id: string): void
  /** Adds a Node archive at `/dist/v<version>/<file>` */
  addNodeArchive(version: string, file: string, bytes: Buffer): void
  close(): Promise<void>
}

export async function fakeRegistry(packages: FakePackage[]): Promise<FakeRegistry> {
  const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const forger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyid = 'SHA256:fake-registry-key'
  const tarballs = new Map<string, Buffer>()
  const served = new Map<string, Buffer>()
  const forged = new Set<string>()
  const files = new Map<string, Buffer>()
  for (const p of packages) {
    const t = tarGz('package', p.files)
    tarballs.set(`${p.name}@${p.version}`, t)
    served.set(`${p.name}@${p.version}`, t)
  }
  const hits: string[] = []
  let base = ''
  const tarPath = (name: string, version: string) => `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    hits.push(path)
    const json = (o: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(o))
    }
    if (path === '/-/npm/v1/keys') {
      return json({ keys: [{ expires: null, keyid, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', key: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] })
    }
    if (files.has(path)) return res.end(files.get(path))
    for (const p of packages) {
      if (path === `/${p.name}/${p.version}`) {
        const id = `${p.name}@${p.version}`
        const integrity = sha512(tarballs.get(id)!)
        const sig = sign('sha256', Buffer.from(`${p.name}@${p.version}:${integrity}`), forged.has(id) ? forger.privateKey : signer.privateKey).toString('base64')
        return json({ name: p.name, version: p.version, dist: { tarball: `${base}${tarPath(p.name, p.version)}`, integrity, signatures: [{ keyid, sig }] } })
      }
      if (path === tarPath(p.name, p.version)) return res.end(served.get(`${p.name}@${p.version}`))
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url: base,
    hits,
    swapTarball: (id, bytes) => void served.set(id, bytes),
    forgeSignature: (id) => void forged.add(id),
    addNodeArchive: (version, file, bytes) => void files.set(`/dist/v${version}/${file}`, bytes),
    close: () => new Promise((r) => server.close(() => r())),
  }
}
