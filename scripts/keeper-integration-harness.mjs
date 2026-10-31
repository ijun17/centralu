/**
 * What the keeper integration scenarios share (`keeper-integration.mjs`): where the binary and the
 * bundled host are, the processes and folders a run made (ended and removed by `cleanup`), how a
 * check is reported, and how a keeper, an attached app and a host client are started.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killFamily, once, printLogTails, waitFor } from './keeper-test-processes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const TARGET = process.env.KEEPER_TARGET_DIR || '/tmp/centralu-keeper-target'

// The keeper executable (#440), started the way a window of this build starts it.
// keeper-handoff-integration.mjs covers the window's executable turning into it.
const BIN = join(TARGET, 'debug', 'centralu-keeper')

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

/** Hosts whose command line names this data folder's store — what "a host for this folder" means */
function hostsFor(data) {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(`${data}/store.db`) && l.includes('main.mjs'))
    .map((l) => ({ pid: Number(l.split(/\s+/, 1)[0]), command: l.replace(/^\d+\s+/, '') }))
}

/**
 * `extra`: more descriptors for the keeper to inherit from 3 on, as an AppImage's window passes its
 * runtime's keep-alive pipe and mount descriptor (`'pipe'` each; their ends here are in `stdio`).
 */
function startKeeper(data, { env = {}, hostSource = HOST_SRC, bin = BIN, extra = [] } = {}) {
  const logFd = openSync(join(data, 'keeper.log'), 'a')
  const child = spawn(
    bin,
    ['--data-dir', data, '--host-source', hostSource, '--bundle-path', FAKE_BUNDLE, '--app-version', '0.0.0-test'],
    {
      // The app starts the keeper in a session of its own; so does this.
      detached: true,
      stdio: ['ignore', logFd, logFd, ...extra],
      env: { ...process.env, CC_DATA_DIR: data, ...env },
    },
  )
  started.add(child.pid)
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return { pid: child.pid, exited, stdio: child.stdio }
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

const cleanup = once((threw) => {
  // A scenario that threw rather than failed a check left its folder's logs worth reading too
  if (threw && currentData) failedDirs.add(currentData)
  printLogTails([...failedDirs], log)
  const hosts = tempDirs.flatMap((d) => (existsSync(d) ? hostsFor(d).map((h) => h.pid) : []))
  killFamily([...started, ...hosts])
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

/** A scenario that threw rather than failed a check counts as a failure too */
function countFailure() {
  failures++
}

export { ROOT, TARGET, BIN, HOST_SRC, FAKE_BUNDLE, started, tempDirs, failures, log, check, hostsFor, startKeeper, attachClient, helloOk, newData, bundleInfo, keyOf, ready, cleanup, countFailure }
