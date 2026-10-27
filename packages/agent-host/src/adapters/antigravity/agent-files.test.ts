import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeZip, type ZipSpec } from '../../apps/external/zip.test-helpers.js'
import { agyPlatformKey, decodedLength, installAgy, isInstalled, realInstallIo, type InstallIo } from './agent-files.js'
import { InstallFailure } from './failure.js'
import { AGY_INSTALL_SPACE_BYTES, AGY_RELEASE, type AgyArchive } from './release.js'
import { tempData } from './agent-files.test-helpers.js'

/**
 * The install (docs/plans/antigravity-adapter.md §3.2) against archives built here: the right one, and each way one can be
 * wrong. The network is a stand-in that serves the bytes in chunks; the disk is a real temporary folder.
 */

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

const FILES: ZipSpec[] = [
  { name: 'agy_acp_server.par', data: 'server', mode: 0o100755 },
  { name: 'localharness_external', data: 'harness', mode: 0o100755 },
]

function archiveOf(zip: Buffer): AgyArchive {
  return { ...AGY_RELEASE.archives['darwin-aarch64'], url: 'https://example.invalid/agy.zip', sha256: createHash('sha256').update(zip).digest('hex') }
}

type Served = { calls: number; cut?: number; failAt?: number; lie?: number; onChunk?: (n: number) => void }

function io(zip: Buffer, served: Served, free: number | null = 10 * AGY_INSTALL_SPACE_BYTES): InstallIo {
  return {
    async download() {
      served.calls++
      const size = 7
      async function* chunks() {
        for (let at = 0, n = 0; at < zip.length; at += size, n++) {
          if (served.failAt === n) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
          served.onChunk?.(n)
          if (served.cut !== undefined && at >= served.cut) return
          yield zip.subarray(at, at + size)
        }
      }
      return { total: served.lie ?? zip.length, chunks: chunks() }
    },
    freeBytes: async () => free,
  }
}

async function install(zip: Buffer, archive: AgyArchive, served: Served, opts: { free?: number | null; signal?: AbortSignal } = {}) {
  const t = tempData()
  data.push(t)
  const progress: { received: number; total: number | null }[] = []
  const run = installAgy(t.home, archive, AGY_RELEASE.version, {
    io: io(zip, served, opts.free === undefined ? 10 * AGY_INSTALL_SPACE_BYTES : opts.free),
    signal: opts.signal ?? new AbortController().signal,
    onProgress: (p) => progress.push(p),
    platform: 'darwin',
  })
  const failure = await run.then(
    () => null,
    (e: unknown) => e,
  )
  return { home: t.home, failure, progress, leftovers: readdirSync(t.home.root).filter((n) => n.startsWith('.install-')) }
}

const reasonOf = (e: unknown) => (e instanceof InstallFailure ? e.reason : e)

describe('installing the pinned agent', () => {
  it('pins one archive for each platform Google ships, each with a sha256', () => {
    for (const [key, a] of Object.entries(AGY_RELEASE.archives)) {
      expect(a.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(a.url, key).toMatch(new RegExp(`^https://dl\\.google\\.com/.+-${AGY_RELEASE.version}-.+\\.zip$`))
      expect(a.files[0], key).toBe(a.command)
    }
    expect(agyPlatformKey('win32', 'arm64')).toBe('windows-aarch64')
    expect(agyPlatformKey('darwin', 'x64')).toBe('darwin-x86_64')
    expect(agyPlatformKey('linux', 'ia32')).toBeNull()
    expect(agyPlatformKey('freebsd', 'x64')).toBeNull()
  })

  it('downloads, checks, unpacks and puts the version in place in one step', async () => {
    const zip = makeZip(FILES)
    const archive = archiveOf(zip)
    const r = await install(zip, archive, { calls: 0 })
    expect(r.failure).toBeNull()
    expect(isInstalled(r.home, archive)).toBe(true)
    expect(readFileSync(join(r.home.versionDir, 'agy_acp_server.par'), 'utf8')).toBe('server')
    expect(readFileSync(join(r.home.versionDir, 'localharness_external'), 'utf8')).toBe('harness')
    expect(r.leftovers).toEqual([])
    expect(r.progress.at(-1)).toEqual({ received: zip.length, total: zip.length })
  })

  it('refuses an archive whose sha256 is not the pinned one, and unpacks nothing of it', async () => {
    const zip = makeZip(FILES)
    const r = await install(zip, { ...archiveOf(zip), sha256: 'f'.repeat(64) }, { calls: 0 })
    expect(reasonOf(r.failure)).toBe('checksum')
    expect(existsSync(r.home.versionDir)).toBe(false)
    expect(r.leftovers).toEqual([])
  })

  it.each<[string, ZipSpec[]]>([
    ['a file the release does not name', [...FILES, { name: 'extra.sh', data: 'x' }]],
    ['a missing file', [FILES[0]!]],
    ['a path out of the folder', [FILES[0]!, { name: '../localharness_external', data: 'x' }]],
    ['a link', [FILES[0]!, { name: 'localharness_external', data: '/etc/passwd', mode: 0o120777 }]],
    ['a lying size', [FILES[0]!, { name: 'localharness_external', data: 'harness', declaredSize: 3 }]],
  ])('refuses an archive with %s (its sha256 pinned as it is)', async (_what, entries) => {
    const zip = makeZip(entries)
    const r = await install(zip, archiveOf(zip), { calls: 0 })
    expect(reasonOf(r.failure)).toBe('unpack')
    expect(existsSync(r.home.versionDir)).toBe(false)
    expect(r.leftovers).toEqual([])
  })

  it('says a full disk before it downloads anything', async () => {
    const zip = makeZip(FILES)
    const served = { calls: 0 }
    const r = await install(zip, archiveOf(zip), served, { free: AGY_INSTALL_SPACE_BYTES - 1 })
    expect(reasonOf(r.failure)).toBe('disk_space')
    expect(served.calls).toBe(0)
  })

  it('says a broken download, and one shorter than it said, as the network', async () => {
    const zip = makeZip(FILES)
    expect(reasonOf((await install(zip, archiveOf(zip), { calls: 0, failAt: 3 })).failure)).toBe('network')
    const short = await install(zip, archiveOf(zip), { calls: 0, cut: 20 })
    expect(reasonOf(short.failure)).toBe('network')
    expect(short.leftovers).toEqual([])
  })

  it('stops on a cancel mid-download and leaves nothing behind', async () => {
    const zip = makeZip(FILES)
    const abort = new AbortController()
    const r = await install(zip, archiveOf(zip), { calls: 0, onChunk: (n) => n === 2 && abort.abort() }, { signal: abort.signal })
    expect(reasonOf(r.failure)).toBe('cancelled')
    expect(existsSync(r.home.versionDir)).toBe(false)
    expect(r.leftovers).toEqual([])
  })

  it('replaces an older version and a damaged copy, and keeps the agent home', async () => {
    const zip = makeZip(FILES)
    const archive = archiveOf(zip)
    const t = tempData()
    data.push(t)
    const old = join(t.home.root, '1.4.2')
    mkdirSync(old, { recursive: true })
    mkdirSync(t.home.versionDir, { recursive: true })
    writeFileSync(join(t.home.versionDir, 'agy_acp_server.par'), 'half')
    mkdirSync(join(t.home.geminiHome, 'antigravity-acp'), { recursive: true })
    mkdirSync(join(t.home.root, '.install-stale'), { recursive: true })
    await installAgy(t.home, archive, AGY_RELEASE.version, { io: io(zip, { calls: 0 }), signal: new AbortController().signal, platform: 'darwin' })
    expect(isInstalled(t.home, archive)).toBe(true)
    expect(readFileSync(join(t.home.versionDir, 'agy_acp_server.par'), 'utf8')).toBe('server')
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(t.home.geminiHome, 'antigravity-acp'))).toBe(true)
    expect(readdirSync(t.home.root).filter((n) => n.startsWith('.install-'))).toEqual([])
  })
})

/**
 * A local server that answers the way Google's download server did (deep review of #1680, measured): gzip whenever the
 * request allows it, with `content-length` the gzipped size. `always` gzips even a request that asked for `identity`
 */
async function gzipServer(body: Buffer, always = false): Promise<{ url: string; asked: IncomingHttpHeaders[]; close(): Promise<void> }> {
  const asked: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    asked.push(req.headers)
    const accepts = String(req.headers['accept-encoding'] ?? '')
    if (always || /gzip/.test(accepts)) {
      const gz = gzipSync(body)
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gz.length, 'content-type': 'application/zip' })
      res.end(gz)
    } else {
      res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/zip' })
      res.end(body)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}/agy.zip`, asked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('the real download, against a server that gzips', () => {
  const zip = makeZip(FILES)

  it('asks for the archive as stored, and installs it', async () => {
    const server = await gzipServer(zip)
    const t = tempData()
    data.push(t)
    try {
      const archive = { ...archiveOf(zip), url: server.url }
      const io: InstallIo = { download: realInstallIo.download, freeBytes: async () => null }
      await installAgy(t.home, archive, AGY_RELEASE.version, { io, signal: new AbortController().signal, platform: 'darwin' })
      expect(isInstalled(t.home, archive)).toBe(true)
      expect(server.asked[0]?.['accept-encoding']).toBe('identity')
    } finally {
      await server.close()
    }
  })

  it('installs even when the server gzips anyway: the sha256 decides, not the length on the wire', async () => {
    const server = await gzipServer(zip, true)
    const t = tempData()
    data.push(t)
    try {
      const archive = { ...archiveOf(zip), url: server.url }
      const io: InstallIo = { download: realInstallIo.download, freeBytes: async () => null }
      await installAgy(t.home, archive, AGY_RELEASE.version, { io, signal: new AbortController().signal, platform: 'darwin' })
      expect(isInstalled(t.home, archive)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('reads content-length as the decoded size only without a content-encoding', () => {
    expect(decodedLength(new Headers({ 'content-length': '10' }))).toBe(10)
    expect(decodedLength(new Headers({ 'content-length': '10', 'content-encoding': 'identity' }))).toBe(10)
    expect(decodedLength(new Headers({ 'content-length': '10', 'content-encoding': 'gzip' }))).toBeNull()
    expect(decodedLength(new Headers({}))).toBeNull()
  })
})

describe('the unpack', () => {
  it('streams a large entry to disk instead of holding it whole in memory', async () => {
    // 160 MB of zeros: a few hundred KB zipped. Unpacked into one buffer, external memory would grow by the whole entry
    const big = Buffer.alloc(160 * 1024 * 1024)
    const zip = makeZip([
      { name: 'agy_acp_server.par', data: big, mode: 0o100755 },
      { name: 'localharness_external', data: 'harness', mode: 0o100755 },
    ])
    const archive = archiveOf(zip)
    const before = process.memoryUsage().arrayBuffers
    let peak = before
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers)
    }, 2)
    try {
      const r = await install(zip, archive, { calls: 0 })
      expect(r.failure).toBeNull()
    } finally {
      clearInterval(sample)
    }
    // Measured: about 320 MB held when the archive and the entry were read whole, about 64 MB streamed (garbage the GC
    // has not yet taken); the bound sits between them
    expect(peak - before).toBeLessThan(big.length * 0.7)
  })
})
