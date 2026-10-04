#!/usr/bin/env node
/**
 * The keeper end to end (#280, option C step 1), with the real binary and the real host.
 *
 *   node scripts/keeper-integration.mjs [--no-build]
 *
 * Builds the desktop binary with `cargo build` into a target folder under /tmp (never
 * `tauri build`, never anything under `target/release/bundle`), bundles the repository's host with
 * `pnpm bundle:host`, and runs `centralu --keeper` against a temporary `CC_DATA_DIR`. A
 * stand-in for the app attaches from a child process, so "the app dies" is a real SIGKILL of a real
 * process.
 *
 * Checked:
 *   - the keeper starts the host from a per-build copy under the data folder, not the bundle;
 *   - an attached client gets the host's port and token, and the host's WebSocket answers
 *     hello_ok with the build it came from;
 *   - a second keeper on the same folder defers to the first and starts no second host;
 *   - background off: killing the attached client stops the host and the keeper;
 *   - background on: killing it leaves both running, a new client re-attaches to the same host,
 *     a switch restarts the host from another build and removes the old copy, and the keeper
 *     ends itself after the idle limit with nothing attached — but not while a terminal is open;
 *   - stop ends everything;
 *   - a keeper killed outright takes its host with it, and a new keeper takes the folder over.
 *
 * Every process it starts is killed before it exits, pass or fail.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = process.env.KEEPER_TARGET_DIR || '/tmp/centralu-keeper-target'
const BIN = join(TARGET, 'debug', 'centralu')
const HOST_SRC = join(ROOT, 'apps/desktop/src-tauri/resources/host')
const FAKE_BUNDLE = '/tmp/centralu-keeper-test/Centralu.app'

const started = new Set()
const tempDirs = []
let failures = 0

function log(msg) {
  process.stdout.write(`${msg}\n`)
}
function check(cond, what, detail = '') {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
  }
  return cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(stepMs)
  }
}
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Hosts whose command line names this data folder's store — what "a host for this folder" means */
function hostsFor(data) {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(`${data}/store.db`) && l.includes('main.mjs'))
    .map((l) => ({ pid: Number(l.split(/\s+/, 1)[0]), command: l.replace(/^\d+\s+/, '') }))
}

function request(sock, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock)
    let buf = ''
    const timer = setTimeout(() => {
      c.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`))
    c.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(timer)
        c.end()
        resolve(JSON.parse(buf.slice(0, nl)))
      }
    })
    c.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
const status = (sock) => request(sock, { op: 'status' }).then((r) => r.view)

function startKeeper(data, { env = {}, hostSource = HOST_SRC } = {}) {
  const logFd = openSync(join(data, 'keeper.log'), 'a')
  const child = spawn(
    BIN,
    ['--keeper', '--data-dir', data, '--host-source', hostSource, '--bundle-path', FAKE_BUNDLE, '--app-version', '0.0.0-test'],
    {
      // The app starts the keeper in a session of its own; so does this.
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CC_DATA_DIR: data, ...env },
    },
  )
  started.add(child.pid)
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return { pid: child.pid, exited }
}

/**
 * A stand-in for the app: a separate process that attaches and stays attached until killed.
 * Its first stdout line is the keeper's answer to the attach.
 */
function attachClient(sock, build) {
  const code = `
    const c = require('node:net').createConnection(${JSON.stringify(sock)})
    c.on('connect', () => c.write(JSON.stringify({ op: 'attach', protocol: 1, build: ${JSON.stringify(build)} }) + '\\n'))
    c.on('data', (d) => process.stdout.write(d))
    c.on('close', () => process.exit(0))
    setInterval(() => {}, 1 << 30)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  started.add(child.pid)
  let buf = ''
  const lines = []
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  return {
    pid: child.pid,
    lines,
    first: () => waitFor(() => lines[0], 10_000),
    kill: () => {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {}
    },
  }
}

async function helloOk(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hello_ok')), 8000)
      ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data))
        if (f.kind === 'hello_ok') {
          clearTimeout(timer)
          resolve(f)
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('websocket error'))
      }
    })
  } finally {
    ws.close()
  }
}

function newData() {
  // Short on purpose: a unix socket path is limited to 104 bytes on macOS.
  const d = mkdtempSync('/tmp/ck-')
  tempDirs.push(d)
  return d
}

const bundleInfo = () => JSON.parse(readFileSync(join(HOST_SRC, 'bundle-info.json'), 'utf8'))
const keyOf = (commit, builtAt) =>
  commit === 'unknown' || commit.endsWith('-dirty') ? `${commit}-${(builtAt ?? '').replace(/\D/g, '') || 'nostamp'}` : commit
const ready = (v) => v?.status?.state === 'ready'

async function scenarioBackgroundOff() {
  log('\nbackground off (the default)')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k1 = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000))) return

  const info = bundleInfo()
  const copy = join(data, 'hosts', keyOf(info.commit, info.builtAt))
  check(view.source?.copyDir === copy, 'the host runs from its per-build copy', `copyDir ${view.source?.copyDir}, expected ${copy}`)
  check(existsSync(join(copy, 'main.mjs')), 'the copy holds the host')
  const hosts = hostsFor(data)
  check(
    hosts.length === 1 && hosts[0].command.includes(`${copy}/main.mjs`) && !hosts[0].command.includes(HOST_SRC),
    'the host process runs the copy, not the bundle',
    JSON.stringify(hosts),
  )
  check((statSync(sock).mode & 0o777) === 0o600, 'the control socket is user-only (0600)', (statSync(sock).mode & 0o777).toString(8))
  check(!readFileSync(join(data, 'keeper.json'), 'utf8').includes(view.status.token), 'keeper.json holds no token')

  const app = attachClient(sock, { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC })
  const first = await app.first()
  check(first?.ok === true && first.sameBuild === true, 'a client attaches and is told it is the same build', JSON.stringify(first))
  const port = first?.view?.status?.port
  const token = first?.view?.status?.token
  check(port > 0 && typeof token === 'string' && token.length > 0, 'the attach answer carries the host port and token')
  try {
    const hello = await helloOk(port, token)
    check(
      hello.build?.commit === info.commit && hello.build?.bundlePath === FAKE_BUNDLE && hello.build?.copyDir === copy,
      "the host's hello_ok names its build and where it came from",
      JSON.stringify(hello.build),
    )
  } catch (e) {
    check(false, "the host's WebSocket answers hello_ok", String(e))
  }

  const hostPid = view.hostPid
  const k2 = startKeeper(data)
  const k2code = await Promise.race([k2.exited, sleep(20_000).then(() => 'still running')])
  check(k2code === 3, 'a second keeper on the same folder defers to the first (exit 3)', `exit ${k2code}`)
  const after = await status(sock)
  check(after.hostPid === hostPid && hostsFor(data).length === 1, 'still one host, the same one', JSON.stringify(hostsFor(data)))
  check(alive(k1.pid), 'the first keeper is untouched')

  app.kill()
  const gone = await waitFor(() => !alive(hostPid) && !alive(k1.pid), 15_000)
  check(gone, 'killing the attached client stops the host and the keeper', `host alive ${alive(hostPid)}, keeper alive ${alive(k1.pid)}`)
  // Stopped through its own shutdown() (sessions, store, WAL checkpoint), not killed outright
  check(
    readFileSync(join(data, 'host.log'), 'utf8').includes(`[agent-host] shutting down (pid ${hostPid})`),
    'the host shut down through its own shutdown path',
  )
  check(!existsSync(sock), 'the socket is removed on the way out')
}

async function scenarioBackgroundOn() {
  log('\nbackground on')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const IDLE = 8
  const k = startKeeper(data, { env: { CC_KEEPER_IDLE_SECS: String(IDLE) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const info = bundleInfo()
  const build = { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC }
  const app1 = attachClient(sock, build)
  await app1.first()
  const set = await request(sock, { op: 'set_background', on: true })
  check(set.ok && set.background === true, 'background mode can be turned on')
  check(JSON.parse(readFileSync(join(data, 'keeper-settings.json'), 'utf8')).background === true, 'and is saved in the data folder')

  app1.kill()
  await sleep(3000)
  const v2 = await status(sock).catch(() => null)
  check(alive(k.pid) && alive(view.hostPid) && v2?.attached === 0, 'killing the client leaves the keeper and the host running', JSON.stringify(v2?.attached))

  const app2 = attachClient(sock, build)
  const first = await app2.first()
  check(
    first?.view?.hostPid === view.hostPid && first?.view?.status?.port === view.status.port,
    'a relaunched client re-attaches to the same host',
    `pid ${first?.view?.hostPid} vs ${view.hostPid}`,
  )

  // Another build: the same host folder with a different stamp.
  const src2 = mkdtempSync('/tmp/ck-src2-')
  tempDirs.push(src2)
  cpSync(HOST_SRC, src2, { recursive: true })
  writeFileSync(join(src2, 'bundle-info.json'), JSON.stringify({ ...info, commit: 'fakecommit2' }))
  const sw = await request(sock, { op: 'switch', source: { commit: 'fakecommit2', hostDir: src2, bundlePath: '/tmp/Other.app' } })
  check(sw.ok, 'switch is accepted')
  const switched = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v.source?.commit === 'fakecommit2' && v
  }, 30_000)
  check(switched && switched.hostPid !== view.hostPid, 'the host restarts from the other build', JSON.stringify(switched?.source))
  check(existsSync(join(data, 'hosts', 'fakecommit2', 'main.mjs')), "the other build gets its own copy")
  const oldCopy = join(data, 'hosts', keyOf(info.commit, info.builtAt))
  check(await waitFor(() => !existsSync(oldCopy), 5000), 'the copy no host uses any more is removed')
  check(!alive(view.hostPid) && hostsFor(data).length === 1, 'the old host is gone and one host remains', JSON.stringify(hostsFor(data)))
  check(
    app2.lines.some((l) => l.event === 'status' && l.view?.source?.commit === 'fakecommit2'),
    'the attached client was told about the switch',
  )

  app2.kill()
  const detachedAt = Date.now()
  const hostPid = switched?.hostPid
  const ended = await waitFor(() => !alive(k.pid) && !alive(hostPid), (IDLE + 15) * 1000, 250)
  const after = (Date.now() - detachedAt) / 1000
  check(ended && after >= IDLE - 1, `with nothing attached and nothing running, it ends itself after the idle limit (${IDLE}s)`, `ended ${!!ended} after ${after.toFixed(1)}s`)
}

async function scenarioStop() {
  log('\nquit and stop agents')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'other', hostDir: HOST_SRC })
  const first = await app.first()
  check(first?.sameBuild === false, 'a client of another build is told so')
  await request(sock, { op: 'set_background', on: true })
  const stop = await request(sock, { op: 'stop' })
  check(stop.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(k.pid) && !alive(view.hostPid), 10_000)
  check(gone, 'stop ends the host and the keeper even with background mode on')
  app.kill()
}

/** A WebSocket client of the host that can make RPC calls */
async function hostClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  let next = 1
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello_ok')), 8000)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data))
      if (f.kind === 'hello_ok') {
        clearTimeout(timer)
        resolve()
      } else if (f.kind === 'res' && pending.has(f.id)) {
        const p = pending.get(f.id)
        pending.delete(f.id)
        f.ok ? p.resolve(f.result) : p.reject(new Error(f.error?.message ?? 'rpc failed'))
      }
    }
    ws.onerror = () => reject(new Error('websocket error'))
  })
  // A host that goes away must fail the calls in flight, or the script would hang on them
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the host closed the connection'))
    pending.clear()
  }
  return {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = String(next++)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, 15_000)
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        })
        if (ws.readyState !== WebSocket.OPEN) return pending.get(id).reject(new Error('the host is gone'))
        ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
      }),
    close: () => ws.close(),
  }
}

async function scenarioBusyHoldsIdle() {
  log('\nan unwatched keeper with something running is not idle')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const IDLE = 3
  const k = startKeeper(data, { env: { CC_KEEPER_IDLE_SECS: String(IDLE) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'x' })
  await app.first()
  await request(sock, { op: 'set_background', on: true })
  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const host = await hostClient(view.status.port, view.status.token)
  try {
    const p = await host.call('projects.add', { path: project })
    const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
    const busy = await waitFor(async () => (await status(sock)).busy, 15_000, 250)
    check(busy, 'an open terminal is reported to the keeper as activity')
    app.kill()
    await sleep((IDLE + 6) * 1000)
    check(alive(k.pid) && alive(view.hostPid), `with a terminal open it outlives the idle limit (${IDLE}s) with no window`)
    await host.call('terminal.close', { terminalId: term.terminalId })
    const ended = await waitFor(() => !alive(k.pid) && !alive(view.hostPid), (IDLE + 15) * 1000, 250)
    check(ended, 'once the terminal closes, it ends itself after the idle limit')
  } catch (e) {
    check(false, 'the host takes a project and a terminal', String(e))
  } finally {
    host.close()
  }
}

async function scenarioKeeperDies() {
  log('\nthe host is tied to the keeper, not the app')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  // The host reads the keeper's stdin pipe (--watch-parent): a keeper killed outright still takes
  // its host with it, so a crashed keeper never leaves an unowned host behind.
  process.kill(k.pid, 'SIGKILL')
  const gone = await waitFor(() => !alive(view.hostPid), 10_000)
  check(gone, 'a SIGKILLed keeper takes its host with it', `host ${view.hostPid} alive ${alive(view.hostPid)}`)
  const k2 = startKeeper(data)
  const again = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  check(again && again.keeper.pid === k2.pid, 'a new keeper takes over the folder (stale socket and all)')
  await request(sock, { op: 'stop' }).catch(() => {})
  await waitFor(() => !alive(k2.pid), 10_000)
}

function cleanup() {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const d of tempDirs) {
    for (const h of existsSync(d) ? hostsFor(d) : []) {
      try {
        process.kill(h.pid, 'SIGKILL')
      } catch {}
    }
    rmSync(d, { recursive: true, force: true })
  }
}

async function main() {
  if (!process.argv.includes('--no-build')) {
    log('bundling the host (pnpm bundle:host)')
    execFileSync('pnpm', ['bundle:host'], { cwd: ROOT, stdio: 'inherit' })
    log(`building the binary (cargo build, CARGO_TARGET_DIR=${TARGET})`)
    const r = spawnSync('cargo', ['build', '--manifest-path', join(ROOT, 'apps/desktop/src-tauri/Cargo.toml')], {
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    })
    if (r.status !== 0) throw new Error('cargo build failed')
  }
  if (!existsSync(BIN)) throw new Error(`no binary at ${BIN}`)
  if (!existsSync(join(HOST_SRC, 'main.mjs'))) throw new Error(`no bundled host at ${HOST_SRC}`)
  await scenarioBackgroundOff()
  await scenarioBackgroundOn()
  await scenarioStop()
  await scenarioBusyHoldsIdle()
  await scenarioKeeperDies()
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
try {
  await main()
} catch (e) {
  failures++
  log(`\nerror: ${e?.stack ?? e}`)
} finally {
  cleanup()
}
log(failures === 0 ? '\nall keeper checks passed' : `\n${failures} keeper check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
