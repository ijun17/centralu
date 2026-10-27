/**
 * **The terminal broker** (Windows, #1067; the host side is `broker-pty.ts`).
 *
 * The host starts this process before it joins the job object that ends its work with it (`lifecycle/work-job.ts`), so
 * it is in no job of the host's. The terminals it starts are therefore outside that job: what a person starts from a
 * Centralu terminal (`code .`, the browser `claude auth login` opens, a server started in the background) outlives the
 * host, as it does on macOS and Linux, while agents, Run commands, git and app servers end with it.
 *
 * A plain `.mjs`, started with `node <path>` in development and beside the bundled host alike (the Codex bridge's way,
 * `adapters/bridge-path.ts`). Its whole protocol is one JSON object per line: the host's requests on stdin,
 * what the terminals do on stdout.
 *
 * - in: `{op:'spawn', id, file, args, cwd, env, cols, rows}` · `{op:'write', id, data}` · `{op:'resize', id, cols, rows}`
 *   · `{op:'kill', id}` · `{op:'open', url}` (an `https` address in the person's browser, review of #1685)
 * - out: `{ev:'ready'}` once · `{ev:'spawned', id, pid}` · `{ev:'error', id, message}` · `{ev:'data', id, data}` ·
 *   `{ev:'exit', id, exitCode, signal}`
 *
 * Its stdin closing means the host is gone: it exits, which closes every pseudoconsole and so ends each shell as the
 * host's own would have. What a shell started outside its console stays.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

/** @type {Map<number, any>} */
const ptys = new Map()
/** Kills asked for before the spawn answered (the host does not wait for a pid to close a tab) */
const killed = new Set()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * On the ConPTY node-pty ships, as the host does (`spawnPty`, #849): Windows' own left a `conhost.exe` per terminal.
 * Only a missing or unloadable `conpty.dll` falls back to Windows' own.
 */
function spawnPty(m) {
  const opts = { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env }
  try {
    return pty.spawn(m.file, m.args, { ...opts, useConptyDll: true })
  } catch (err) {
    if (!/conpty\.dll/i.test(err.message)) throw err
    process.stderr.write(`[pty-broker] ${err.message}; using the console of Windows instead\n`)
    return pty.spawn(m.file, m.args, opts)
  }
}

/**
 * The person's browser at an address (Antigravity's sign-in page): started from here, outside the host's job, so it
 * outlives the sign-in and the host. `detached`, so libuv puts it in no job of this process's either (it ends with this
 * one otherwise); never through a shell, and only an `https` address
 */
function open(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return
  try {
    const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The sign-in times out, which says the browser did not open
  }
}

function handle(m) {
  if (m.op === 'open') return open(m.url)
  if (m.op === 'spawn') {
    let p
    try {
      p = spawnPty(m)
    } catch (err) {
      return send({ ev: 'error', id: m.id, message: err.message })
    }
    ptys.set(m.id, p)
    send({ ev: 'spawned', id: m.id, pid: p.pid })
    p.onData((data) => send({ ev: 'data', id: m.id, data }))
    p.onExit(({ exitCode, signal }) => {
      ptys.delete(m.id)
      send({ ev: 'exit', id: m.id, exitCode, signal: signal ?? null })
    })
    if (killed.delete(m.id)) p.kill()
    return
  }
  const p = ptys.get(m.id)
  if (m.op === 'kill') {
    if (p) p.kill()
    else killed.add(m.id)
    return
  }
  if (!p) return
  try {
    if (m.op === 'write') p.write(m.data)
    else if (m.op === 'resize') p.resize(m.cols, m.rows)
  } catch {
    // a pty in the middle of ending: its exit follows
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  handle(m)
})
// The host is gone (closed, crashed, killed): every pseudoconsole closes with this process
lines.on('close', () => process.exit(0))
send({ ev: 'ready' })
