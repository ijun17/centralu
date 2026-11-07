import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * predates it. `FAKE_STOP_FAILS` makes `--stop` refuse, or with `-` only when no version runs. `--connection` prints a connection line with the running
 * version, and with `installInfo` (the URL of the real `serve-install.mjs`) the `install` field it reads.
 * `fromPackage`: the version is the one in `../package.json` beside it, as a dev build stamps it (#1036).
 * `FAKE_MIGRATES=<version>` plays a version whose migration only it reads: starting, it writes `needs <version>` to
 * `<data>/store.db`, and any other version refuses that store (`StoreTooNewError` in host.log).
 *
 * The data folder's lock (#1903): `--detach` refuses, as a host does, while `<data>/host.lock` names a live process.
 * With `realServe` (the URL of the real `serve.mjs`), `FAKE_HANGS=<version>` plays a version whose host takes the lock
 * and then hangs: a process started outside the session as the real launcher starts its host, which never answers,
 * holds `host.lock` as a serve-started host writes it, its pid in `<data>/hung`, and `--detach` answers that it did not
 * answer in time. `--stop` while such a holder lives is the real launcher's (`runStop`). It listens on a port of its own,
 * `<data>/hung.port`: `hungListening` is how a test tells that it lives (not by its pid: a freed pid goes to the next process, #2082).
 *
 * The switch (plan §10.5a): with `realServe`, `--switch`, `--switch-run` and `--switch-status` are the real launcher's,
 * and `--detach` asks its gate first (`beforeHostStart`), so the real switcher drives these fake versions through their
 * CLI. A switcher started through WMI gets the account's environment, not the test's, so every `FAKE_*` is read from
 * `<data>/fake-env.json` too. `FAKE_SILENT=<version>`: `--connection` says no host runs while that version would.
 * `FAKE_HOLD=stop` or `FAKE_HOLD=start <version>` holds that command (`<data>/holding` says so) until `<data>/release`
 * appears: `go` lets it on, `quit` ends it having done nothing, as a switcher killed there leaves it. `stopped` holds a
 * stop once it stopped the host, and `connection <version>` that version's `--connection` while a host runs. Each
 * holds once. `FAKE_WMI_BLOCKED`: the handover can start nothing outside the session (WMI blocked), so the switch runs
 * in it. `FAKE_NO_GATE=<version>` plays a version from before the switch: its `--detach` asks no switch. A `--detach`
 * while a host runs answers that one, as the real launcher does.
 */
export const fakeServe = (version: string, o: { fromPackage?: boolean; installInfo?: string; realServe?: string } = {}) => `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
${o.installInfo ? `import { installInfo } from ${JSON.stringify(o.installInfo)}` : ''}
${o.realServe ? `import * as real from ${JSON.stringify(o.realServe)}` : 'const real = null'}
const V = ${o.fromPackage ? "JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version" : JSON.stringify(version)}
const d = process.env.CC_DATA_DIR || process.env.HOME + '/.centralu'
const a = process.argv.slice(2).join(' ')
const fileEnv = (() => {
  try {
    return JSON.parse(readFileSync(d + '/fake-env.json', 'utf8'))
  } catch {
    return {}
  }
})()
const F = (k) => process.env[k] ?? fileEnv[k]
const home = process.env.HOME || process.env.USERPROFILE
let gate = null
const hold = async (what) => {
  const once = d + '/held-' + what.replace(/[^\\w]/g, '_')
  if (F('FAKE_HOLD') !== what || existsSync(once)) return
  writeFileSync(once, '')
  writeFileSync(d + '/holding', what)
  while (!existsSync(d + '/release')) await new Promise((r) => setTimeout(r, 50))
  const said = readFileSync(d + '/release', 'utf8')
  rmSync(d + '/release', { force: true })
  rmSync(d + '/holding', { force: true })
  if (said === 'quit') process.exit(3)
}
const log = (s) => appendFileSync(d + '/events', s + '\\n')
const lockPid = () => {
  try {
    const pid = JSON.parse(readFileSync(d + '/host.lock', 'utf8')).pid
    // With the real launcher the lock is read as it reads it, by the pid and the time it started: a freed pid names the next process (#2082)
    if (real) return real.lockHolderIsAlive(d) ? pid : null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}
if (real && a.startsWith('serve --switch')) {
  const [, mode, arg, seen] = process.argv.slice(2)
  // FAKE_WMI_BLOCKED: nothing can be started outside the session, so the switch runs in it
  const start = F('FAKE_WMI_BLOCKED') ? async () => ({ ok: false, blocked: true, message: 'WMI is blocked here' }) : undefined
  if (mode === '--switch') process.exitCode = await real.runSwitch({ env: process.env, home, raw: arg, cliPath: fileURLToPath(import.meta.url), start })
  else if (mode === '--switch-run') process.exitCode = await real.runSwitchRun({ env: process.env, home, raw: arg, dataDir: seen ?? null })
  else process.exitCode = await real.runSwitchStatus({ env: process.env, home, seen: seen ?? null })
} else if (a === 'serve --stop') {
  await hold('stop')
  const was = existsSync(d + '/running')
  log('stop ' + (was ? readFileSync(d + '/running', 'utf8') : lockPid() ? 'hung' : '-') + (process.env.CENTRALU_STOP_FOR === 'update' ? ' (for update)' : ''))
  rmSync(d + '/running', { force: true })
  if (real && lockPid()) await real.runStop({ env: process.env, home, entry: d + '/no-host.mjs' })
  else console.log(JSON.stringify({ v: 1, stop: F('FAKE_STOP_FAILS') === '1' || (F('FAKE_STOP_FAILS') === '-' && !was) ? { ok: false, wasRunning: true, message: 'the host on 127.0.0.1:4141 is still running' } : { ok: true, wasRunning: was } }))
  await hold('stopped')
} else if ((a === 'serve --detach' || a.startsWith('serve --detach --from ')) && real && F('FAKE_NO_GATE') !== V && (gate = await real.beforeHostStart({ dataDir: d, env: process.env, version: V })) && !gate.go) {
  if (gate.rerun) process.exitCode = await real.rerunAs(d, gate.rerun, process.argv.slice(2), process.env)
  else console.log(JSON.stringify({ v: 1, detach: { ok: false, how: 'setsid', reason: 'switching', by: gate.by, startedAt: gate.startedAt, message: 'switching' } }))
} else if ((a === 'serve --detach' || a.startsWith('serve --detach --from ')) && existsSync(d + '/running')) {
  const now = readFileSync(d + '/running', 'utf8')
  console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: now, protocolVersion: 1, dataDir: d, hostRunning: true, detach: { ok: true, how: 'setsid', already: true } }))
} else if (a === 'serve --detach' || a.startsWith('serve --detach --from ')) {
  await hold('start ' + V)
  log('start ' + V)
  // FAKE_MIGRATES=<version>: that version migrates the store so only it reads it; any other then refuses it
  if (F('FAKE_MIGRATES') === V) writeFileSync(d + '/store.db', 'needs ' + V)
  const store = existsSync(d + '/store.db') ? readFileSync(d + '/store.db', 'utf8') : ''
  if (lockPid()) {
    appendFileSync(d + '/host.log', 'host ' + V + ': the data folder is in use by another Centralu host (pid ' + lockPid() + ')\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else if (real && F('FAKE_HANGS') === V) {
    // It listens on a port of its own and writes it to <data>/hung.port, so a test tells it is gone by that: a pid names nothing once the process
    // is, since Windows hands it to the next process that starts (see hungListening)
    const hung = await real.startDetached({ how: process.platform === 'win32' ? 'wmi' : 'setsid', execPath: process.execPath, args: ['-e', "require('net').createServer().listen(0,'127.0.0.1',function(){require('fs').writeFileSync(process.argv[1],String(this.address().port))});setInterval(function(){},1e6)", d + '/hung.port'], env: process.env, cwd: d })
    if (!hung.ok) throw new Error(hung.message)
    // The answer below says the host never answered: it is said once the process has listened, so what a test finds is what it left
    for (let i = 0; i < 400 && !(existsSync(d + '/hung.port') && readFileSync(d + '/hung.port', 'utf8') !== ''); i++) await new Promise((r) => setTimeout(r, 50))
    writeFileSync(d + '/host.lock', JSON.stringify({ pid: hung.pid, started: real.processStartTime(hung.pid), at: Date.now(), by: 'serve' }))
    writeFileSync(d + '/hung', String(hung.pid))
    const free = createServer()
    await new Promise((r) => free.listen(0, '127.0.0.1', r))
    real.ensureServeState(d)
    real.recordServePort(d, free.address().port)
    await new Promise((r) => free.close(r))
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'timeout', message: 'the host did not answer within 30 s' } }))
  } else if (store.startsWith('needs ') && store.slice(6) !== V) {
    appendFileSync(d + '/host.log', 'host ' + V + ': StoreTooNewError: this store needs Centralu ' + store.slice(6) + '\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else if (F('FAKE_BROKEN') === V) {
    appendFileSync(d + '/host.log', 'host ' + V + ': the store was written by a newer Centralu\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else {
    writeFileSync(d + '/running', V)
    console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: V, protocolVersion: 1, dataDir: d, hostRunning: true, detach: { ok: true, how: 'setsid' } }))
  }
} else if (a === 'serve --connection') {
  if (existsSync(d + '/running')) await hold('connection ' + V)
  const said = existsSync(d + '/running') ? readFileSync(d + '/running', 'utf8') : null
  const running = said !== null && said !== F('FAKE_SILENT') ? said : null
  ${o.installInfo ? 'const install = installInfo(d, process.env)' : 'const install = undefined'}
  console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: running ?? V, protocolVersion: Number(F('FAKE_PROTOCOL') || 1), dataDir: d, hostRunning: running !== null, ...(install ? { install } : {}) }))
} else if (a === 'serve --autostart off' || a === 'serve --autostart remove') {
  log(a.slice('serve --'.length))
  if (F('FAKE_NO_AUTOSTART')) {
    console.error('unknown option for serve: --autostart')
    process.exitCode = 2
  } else if (F('FAKE_AUTOSTART_FAILS')) {
    console.log(JSON.stringify({ v: 1, autostart: { ok: false, on: true, how: 'systemd', linger: null, message: 'Failed to connect to bus' } }))
  } else {
    rmSync(d + '/autostart', { force: true })
    console.log(JSON.stringify({ v: 1, autostart: { ok: true, on: false, how: 'systemd', linger: null } }))
  }
} else console.log('unexpected ' + a)
`

/**
 * Whether the process a `FAKE_HANGS` version left behind lives: whether anything accepts a connection on the port it wrote to
 * `<data>/hung.port`. Not by `process.kill(pid, 0)`: Windows hands a freed pid to a process that starts later, within seconds on a
 * busy runner, and that one answers the same (#2082: the check ran after the stop had seen the process gone, and found its pid alive).
 */
export function hungListening(dataDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port: Number(readFileSync(join(dataDir, 'hung.port'), 'utf8')), host: '127.0.0.1' })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })
}

const SERVE_FILES = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve-files.mjs')).href

/**
 * Whether the process a `FAKE_HANGS` version left behind is still the one its lock names: the launcher's own reading of
 * `host.lock` (`lockHolderIsAlive`: the pid and the time it started, or created before the lock was written), so a freed pid
 * that another process took reads as gone. What a test's cleanup asks before it kills that pid, port or no port: a fake that
 * failed before it listened still leaves its process behind.
 */
export async function hungHolderAlive(dataDir: string): Promise<boolean> {
  const { lockHolderIsAlive } = (await import(SERVE_FILES)) as { lockHolderIsAlive: (dir: string) => boolean }
  return lockHolderIsAlive(dataDir)
}
