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
    // Relative paths from `dir`: the tar first on PATH may be GNU tar (the one Git for Windows brings,
    // on a Windows runner), which reads the `C:` of an absolute Windows path as a remote host
    execFileSync('tar', ['-czf', 'out.tgz', top], { cwd: dir })
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
  const tarPath = (name: string, version: string) => `/${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`
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

/**
 * A fake `centralu.mjs` for update tests: plays its version's `serve`. `--stop` and `--detach` write what
 * happened to `<data>/events` and which version runs to `<data>/running`; `FAKE_BROKEN=<version>` makes that
 * version fail to start and leave a line in `host.log`. `--autostart off` and `remove` remove `<data>/autostart`, the
 * stand-in for a boot entry; `FAKE_AUTOSTART_FAILS` makes it refuse, `FAKE_NO_AUTOSTART` plays a version that
 * predates it, `FAKE_NO_REMOVE` one that predates `remove`. `FAKE_STOP_FAILS` makes `--stop` refuse. `--connection` prints a connection line with the running
 * version, and with `installInfo` (the URL of the real `serve-install.mjs`) the `install` field it reads.
 * `fromPackage`: the version is the one in `../package.json` beside it, as a dev build stamps it (#1036).
 * `FAKE_MIGRATES=<version>` plays a version whose migration only it reads: starting, it writes `needs <version>` to
 * `<data>/store.db`, and any other version refuses that store (`StoreTooNewError` in host.log). `--stop` marks the
 * event `(held)` while a swap's hold is there (swap-hold.ts).
 */
export const fakeServe = (version: string, o: { fromPackage?: boolean; installInfo?: string } = {}) => `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
${o.installInfo ? `import { installInfo } from ${JSON.stringify(o.installInfo)}` : ''}
const V = ${o.fromPackage ? "JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version" : JSON.stringify(version)}
const d = process.env.CC_DATA_DIR || process.env.HOME + '/.centralu'
const a = process.argv.slice(2).join(' ')
const log = (s) => appendFileSync(d + '/events', s + '\\n')
if (a === 'serve --stop') {
  const was = existsSync(d + '/running')
  log('stop ' + (was ? readFileSync(d + '/running', 'utf8') : '-') + (existsSync(d + '/remote/hold.json') ? ' (held)' : '') + (process.env.CENTRALU_STOP_FOR === 'update' ? ' (for update)' : ''))
  rmSync(d + '/running', { force: true })
  console.log(JSON.stringify({ v: 1, stop: process.env.FAKE_STOP_FAILS ? { ok: false, wasRunning: true, message: 'the host on 127.0.0.1:4141 is still running' } : { ok: true, wasRunning: was } }))
} else if (a === 'serve --detach') {
  log('start ' + V)
  // FAKE_MIGRATES=<version>: that version migrates the store so only it reads it; any other then refuses it
  if (process.env.FAKE_MIGRATES === V) writeFileSync(d + '/store.db', 'needs ' + V)
  const store = existsSync(d + '/store.db') ? readFileSync(d + '/store.db', 'utf8') : ''
  if (store.startsWith('needs ') && store.slice(6) !== V) {
    appendFileSync(d + '/host.log', 'host ' + V + ': StoreTooNewError: this store needs Centralu ' + store.slice(6) + '\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else if (process.env.FAKE_BROKEN === V) {
    appendFileSync(d + '/host.log', 'host ' + V + ': the store was written by a newer Centralu\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else {
    writeFileSync(d + '/running', V)
    console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: V, protocolVersion: 1, dataDir: d, hostRunning: true, detach: { ok: true, how: 'setsid' } }))
  }
} else if (a === 'serve --connection') {
  const running = existsSync(d + '/running') ? readFileSync(d + '/running', 'utf8') : null
  ${o.installInfo ? 'const install = installInfo(d, process.env)' : 'const install = undefined'}
  console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: running ?? V, protocolVersion: Number(process.env.FAKE_PROTOCOL || 1), dataDir: d, hostRunning: running !== null, ...(install ? { install } : {}) }))
} else if (a === 'serve --autostart remove' && process.env.FAKE_NO_REMOVE) {
  // A serve from before \`--autostart remove\` (#1224), where uninstall's \`off\` removed the entry
  console.error('--autostart needs on, off or status (got "remove")')
  process.exitCode = 2
} else if (a === 'serve --autostart off' || a === 'serve --autostart remove') {
  log(a.slice('serve --'.length))
  if (process.env.FAKE_NO_AUTOSTART) {
    console.error('unknown option for serve: --autostart')
    process.exitCode = 2
  } else if (process.env.FAKE_AUTOSTART_FAILS) {
    console.log(JSON.stringify({ v: 1, autostart: { ok: false, on: true, how: 'systemd', linger: null, message: 'Failed to connect to bus' } }))
  } else {
    rmSync(d + '/autostart', { force: true })
    console.log(JSON.stringify({ v: 1, autostart: { ok: true, on: false, how: 'systemd', linger: null } }))
  }
} else console.log('unexpected ' + a)
`
