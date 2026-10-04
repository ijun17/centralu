#!/usr/bin/env node
/**
 * The keeper end to end (#280, option C steps 1 and 3), with the real binary and the real host.
 *
 *   node scripts/keeper-integration.mjs [--no-build] [--only <scenario>[,<scenario>]]
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
 *     a switch moves the host to another build and removes the old copy, and the keeper
 *     ends itself after the idle limit with nothing attached — but not while a terminal is open;
 *   - stop ends everything;
 *   - a keeper killed outright takes its host with it, and a new keeper takes the folder over.
 *
 * Step 3 (the front door and the blue-green swap):
 *   - clients and the host's Codex bridge address are the front door's, not the host's own port,
 *     and the host gets the front door's token;
 *   - a swap closes connections through the door, the same address and token reach the new host
 *     after a reconnect, the attached app hears every phase, one host remains, running from the
 *     new build's copy, and the old copy is removed; a bridge process started before the swap
 *     reaches the new host on its next call;
 *   - a swap to a broken build fails its standby check and leaves the running host serving, its
 *     clients connected;
 *   - a new host that fails after the old one drained is reported, and the old build serves again;
 *   - the drain answers a slow call the host serves itself with a retryable error once the bound
 *     (shortened to 1.5 s here) has passed, and the swap reports what it cut.
 *
 * It needs no model and no network, and CI runs all of it (the `keeper` job in
 * `.github/workflows/build.yml`).
 *
 * Every process it starts, and everything those start, is killed before it exits, pass or fail
 * (`keeper-test-processes.mjs`); a failed scenario prints the end of its keeper's and host's logs.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupOnExit, killFamily, once, printLogTails } from './keeper-test-processes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = process.env.KEEPER_TARGET_DIR || '/tmp/centralu-keeper-target'
const BIN = join(TARGET, 'debug', 'centralu')
const HOST_SRC = join(ROOT, 'apps/desktop/src-tauri/resources/host')
const FAKE_BUNDLE = '/tmp/centralu-keeper-test/Centralu.app'

const started = new Set()
const tempDirs = []
/** The data folders of scenarios with a failed check: their logs are printed before they are removed */
const failedDirs = new Set()
let currentData = null
let failures = 0

function log(msg) {
  process.stdout.write(`${msg}\n`)
}
function check(cond, what, detail = '') {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    if (currentData) failedDirs.add(currentData)
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
  currentData = d
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
    readFileSync(join(data, 'host.log'), 'utf8').includes(`[agent-host] shutting down (pid ${hostPid}, stopped)`),
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

// ── Step 3: the front door and the blue-green swap ─────────────────────────────────────────────

/**
 * A WebSocket client through the front door, with its hello_ok and a promise for its close. Calls
 * reject with the host's own error message, so a drain's cut can be read back.
 */
async function frontClient(port, token, timeoutMs = 8000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  let next = 1
  let onClose
  const closed = new Promise((r) => (onClose = r))
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello_ok')), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data))
      if (f.kind === 'hello_ok') {
        clearTimeout(timer)
        resolve(f)
      } else if (f.kind === 'res' && pending.has(f.id)) {
        const p = pending.get(f.id)
        pending.delete(f.id)
        f.ok ? p.resolve(f.result) : p.reject(Object.assign(new Error(f.error?.message ?? 'rpc failed'), { retryable: f.error?.retryable }))
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    }
  })
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the host closed the connection'))
    pending.clear()
    onClose(Date.now())
  }
  return {
    hello,
    closed,
    open: () => ws.readyState === WebSocket.OPEN,
    call: (method, params, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const id = String(next++)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, ms)
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

/** Reconnects to the front door until a host greets, the way the UI's rpc-client does */
async function reconnect(port, token, limitMs = 40_000) {
  const end = Date.now() + limitMs
  for (;;) {
    try {
      return await frontClient(port, token, 15_000)
    } catch (e) {
      if (Date.now() > end) throw e
      await sleep(200)
    }
  }
}

/** A second build: the bundled host under another commit, or a stand-in main.mjs */
function makeBuild(commit, mainMjs) {
  const dir = mkdtempSync('/tmp/ck-src-')
  tempDirs.push(dir)
  cpSync(HOST_SRC, dir, { recursive: true })
  writeFileSync(join(dir, 'bundle-info.json'), JSON.stringify({ ...bundleInfo(), commit }))
  if (mainMjs) writeFileSync(join(dir, 'main.mjs'), mainMjs)
  return dir
}

/** The ports a process listens on */
function listening(pid) {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => Number(l.split(':').pop()))
}

/** The environment a process was started with (macOS `ps eww`). Never printed: it holds the token */
function startEnv(pid) {
  return spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? ''
}

/** The swap phases an attached client was told, in order, without repeats */
function phases(app) {
  const seen = []
  for (const l of app.lines) {
    const p = l.view?.swap?.phase
    if (p && seen[seen.length - 1] !== p) seen.push(p)
  }
  return seen
}
const swapOf = async (sock) => (await status(sock))?.swap

/** The Codex bridge from a host copy, spoken to the way codex speaks to it */
function startBridge(copyDir, url, token) {
  const child = spawn(process.execPath, [join(copyDir, 'codex-orchestrator-bridge.mjs')], {
    env: { ...process.env, CC_HOST_URL: url, CC_HOST_TOKEN: token, CC_SESSION_ID: 'integration-no-such-session' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  started.add(child.pid)
  const got = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      got.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  let id = 0
  return {
    ask: async (method, params = {}) => {
      const my = ++id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
      return waitFor(() => got.find((m) => m.id === my), 20_000)
    },
    kill: () => child.kill('SIGKILL'),
  }
}

async function scenarioSwap() {
  log('\nblue-green swap through the front door')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  startKeeper(data, { env: { CC_KEEPER_DRAIN_MS: '1500' } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000))) return
  const info = bundleInfo()
  const app = attachClient(sock, { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC })
  await app.first()
  const { port, token } = view.status
  const door = `ws://127.0.0.1:${port}`

  check(JSON.parse(readFileSync(join(data, 'keeper.json'), 'utf8')).frontDoor === door, 'keeper.json names the front door (and no token)')
  check(!listening(view.hostPid).includes(port) && listening(view.hostPid).length > 0, 'clients are given the front door, not the host’s own port', `door ${port}, host listens on ${listening(view.hostPid)}`)
  const env = startEnv(view.hostPid)
  check(env.includes(`CC_FRONT_DOOR=${door}`), 'the host is told the front door, which it gives the Codex bridge')
  check(env.includes(`CC_HOST_TOKEN=${token}`), 'the host is given the front door’s token, so clients keep one token across hosts')

  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const c1 = await frontClient(port, token)
  const p = await c1.call('projects.add', { path: project })
  const copyA = view.source.copyDir
  const bridge = startBridge(copyA, door, token)
  const before = await bridge.ask('tools/list')
  check(before && (before.result || before.error), 'a Codex bridge with the front door in its environment reaches the host', JSON.stringify(before))

  const src2 = makeBuild('swapcommit2')
  const sw = await request(sock, { op: 'switch', source: { commit: 'swapcommit2', hostDir: src2, bundlePath: '/tmp/Other.app' } })
  check(sw.ok, 'switch is accepted')
  const closedAt = await Promise.race([c1.closed, sleep(30_000).then(() => null)])
  check(closedAt, 'the swap closes the connection through the front door')
  const c2 = await reconnect(port, token)
  const reconnectMs = Date.now() - (closedAt ?? Date.now())
  check(
    c2.hello.build?.copyDir === join(data, 'hosts', 'swapcommit2') && c2.hello.streamEpoch !== c1.hello.streamEpoch,
    `the same address and token reach the new host after a reconnect (${reconnectMs} ms), on a new stream epoch`,
    JSON.stringify(c2.hello.build),
  )
  const projects = await c2.call('projects.list', {})
  check(projects.some((x) => x.id === p.id), 'the new host serves the same store')
  const done = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'done' && s
  }, 10_000)
  check(done, 'the swap reports done')
  const seen = phases(app)
  const order = ['starting', 'standby', 'draining', 'activating', 'done']
  check(order.every((ph, i) => seen.indexOf(ph) >= 0 && (i === 0 || seen.indexOf(ph) > seen.indexOf(order[i - 1]))), 'the attached app was told every phase, in order', seen.join(' > '))
  const after = await status(sock)
  check(after.status.port === port && after.status.token === token, 'the front door’s port and token did not change')
  check(!alive(view.hostPid), 'the old host is gone')
  const hosts = hostsFor(data)
  check(hosts.length === 1 && hosts[0].command.includes(join(data, 'hosts', 'swapcommit2', 'main.mjs')), 'one host remains, running from the new build’s per-build copy', JSON.stringify(hosts))
  check(await waitFor(() => !existsSync(copyA), 5000), 'the old build’s copy is removed afterwards')
  const later = await bridge.ask('tools/list')
  const text = JSON.stringify(later)
  check(later && !/closed before it answered|ECONNREFUSED|timed out/.test(text), 'the same bridge process reaches the new host on its next call', text)
  bridge.kill()
  c2.close()

  // A broken build: it fails its start check, and the running host never notices
  log('\na swap to a broken build')
  const c3 = await frontClient(port, token)
  const hostBefore = after.hostPid
  const broken = makeBuild('brokencommit', "console.log('this build is broken: it cannot even start'); process.exit(1)\n")
  await request(sock, { op: 'switch', source: { commit: 'brokencommit', hostDir: broken } })
  const failed = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'failed' && s.target.commit === 'brokencommit' && s
  }, 30_000)
  check(failed && /cannot even start/.test(failed.message) && failed.rolledBack === false, 'the failure is reported with the build’s own words, without a rollback', JSON.stringify(failed))
  check(c3.open() && (await c3.call('projects.list', {})).some((x) => x.id === p.id), 'a client connected through the front door kept being served throughout')
  check((await status(sock)).hostPid === hostBefore && alive(hostBefore), 'the running host was not touched')
  check(!existsSync(join(data, 'hosts', 'brokencommit')), 'the broken build’s copy is removed')
  c3.close()

  // B passes standby, then fails after A drained: A's build is started again
  log('\na new host that fails after the old one drained')
  const fails = makeBuild(
    'failsoncommit',
    [
      "if (process.argv.includes('--standby')) {",
      "  console.log(JSON.stringify({ standby: { pid: process.pid } }))",
      "  process.stdin.on('data', (d) => { if (String(d).includes('activate')) { console.log('simulated failure while taking over'); process.exit(1) } })",
      "} else { console.log('this build never starts'); process.exit(1) }",
      '',
    ].join('\n'),
  )
  await request(sock, { op: 'switch', source: { commit: 'failsoncommit', hostDir: fails } })
  const rolled = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'failed' && s.target.commit === 'failsoncommit' && s
  }, 40_000)
  check(rolled && rolled.rolledBack === true && /simulated failure/.test(rolled.message), 'the failure after the drain is reported, with the previous build started again', JSON.stringify(rolled))
  const back = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v.source?.commit === 'swapcommit2' && v.hostPid && v.hostPid !== hostBefore && alive(v.hostPid) && v
  }, 30_000)
  const runningNow = hostsFor(data)
  check(
    back && runningNow.length === 1 && runningNow[0].pid === back.hostPid && runningNow[0].command.includes(join(data, 'hosts', 'swapcommit2', 'main.mjs')),
    'the previous build serves again, as a new process from its own copy',
    JSON.stringify({ source: back?.source, runningNow }),
  )
  const c4 = await reconnect(port, token)
  check((await c4.call('projects.list', {})).some((x) => x.id === p.id), 'through the same front door, on the same store')
  c4.close()
  await request(sock, { op: 'stop' }).catch(() => {})
}

/**
 * A user-folder app whose one tool never answers in time: a plain stdio JSON-RPC server, so the
 * test needs no SDK. Called through `apps.invoke`, the host serves the call itself, which is exactly
 * what a drain has to bound.
 */
function plantSlowApp(data) {
  const dir = join(data, 'apps', 'slowapp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'centralu.app.json'),
    JSON.stringify({ manifestVersion: 1, id: 'slowapp', name: 'Slow app', version: '0.1.0', description: 'never answers in time', server: { command: process.execPath, args: ['server.mjs'] } }),
  )
  writeFileSync(
    join(dir, 'server.mjs'),
    [
      "let buf = ''",
      "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
      "process.stdin.on('data', (d) => {",
      '  buf += d',
      "  for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {",
      '    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)',
      "    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'slowapp', version: '1' } } })",
      "    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'slow', description: 'Takes a minute', inputSchema: { type: 'object', properties: {} } }] } })",
      "    else if (m.method === 'tools/call') setTimeout(() => send({ id: m.id, result: { content: [{ type: 'text', text: 'finally' }] } }), 60000)",
      "    else if (m.method === 'ping') send({ id: m.id, result: {} })",
      '  }',
      '})',
      "process.stdin.on('end', () => process.exit(0))",
      '',
    ].join('\n'),
  )
}

async function scenarioDrainCutsSlowCall() {
  log('\nthe drain bounds a slow call the host serves itself')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  plantSlowApp(data)
  const BOUND = 1500
  startKeeper(data, { env: { CC_KEEPER_DRAIN_MS: String(BOUND) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'x' })
  await app.first()
  const c = await frontClient(view.status.port, view.status.token)
  const apps = await c.call('apps.list', {})
  if (!check(apps.some((a) => a.appId === 'slowapp'), 'the slow app is installed', JSON.stringify(apps.map((a) => a.appId)))) return
  const t0 = Date.now()
  const slow = c.call('apps.invoke', { appId: 'slowapp', name: 'slow', args: {} }, 60_000).then(
    (v) => ({ ok: true, v, at: Date.now() }),
    (e) => ({ ok: false, e, at: Date.now() }),
  )
  await sleep(800)
  const src2 = makeBuild('afterdrain')
  const drainAsked = Date.now()
  await request(sock, { op: 'switch', source: { commit: 'afterdrain', hostDir: src2 } })
  const r = await slow
  const waited = r.at - drainAsked
  check(
    !r.ok && /stopped waiting for this call after 1\.5s/.test(r.e.message) && r.e.retryable === true,
    'the call still running at the bound is answered with a retryable error that says why',
    r.ok ? JSON.stringify(r.v) : `${r.e.message} (retryable ${r.e.retryable})`,
  )
  check(waited >= BOUND - 200 && waited < BOUND + 8000, `the old host waited out the bound (${BOUND} ms) and no longer (${waited} ms after the switch, ${r.at - t0} ms after the call)`)
  const done = await waitFor(async () => {
    const s = await swapOf(sock)
    return (s?.phase === 'done' || s?.phase === 'failed') && s
  }, 30_000)
  check(done?.phase === 'done' && done.cut?.includes('rpc apps.invoke'), 'the swap completes and reports what it cut', JSON.stringify(done))
  await request(sock, { op: 'stop' }).catch(() => {})
}

const cleanup = once((threw) => {
  // A scenario that threw rather than failed a check left its folder's logs worth reading too
  if (threw && currentData) failedDirs.add(currentData)
  printLogTails([...failedDirs], log)
  const hosts = tempDirs.flatMap((d) => (existsSync(d) ? hostsFor(d).map((h) => h.pid) : []))
  killFamily([...started, ...hosts])
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

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
  const scenarios = {
    'background-off': scenarioBackgroundOff,
    'background-on': scenarioBackgroundOn,
    stop: scenarioStop,
    'busy-holds-idle': scenarioBusyHoldsIdle,
    'keeper-dies': scenarioKeeperDies,
    swap: scenarioSwap,
    drain: scenarioDrainCutsSlowCall,
  }
  const at = process.argv.indexOf('--only')
  const only = at >= 0 ? process.argv[at + 1].split(',') : Object.keys(scenarios)
  for (const name of only) {
    if (!scenarios[name]) throw new Error(`no scenario ${name}; there are ${Object.keys(scenarios).join(', ')}`)
    await scenarios[name]()
  }
}

cleanupOnExit(cleanup, log)
try {
  await main()
} catch (e) {
  failures++
  log(`\nerror: ${e?.stack ?? e}`)
  cleanup(true)
} finally {
  cleanup()
}
log(failures === 0 ? '\nall keeper checks passed' : `\n${failures} keeper check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
