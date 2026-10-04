#!/usr/bin/env node
/**
 * The keeper holding agents, terminals and commands (#280, option C step 2), end to end with the
 * real binary, the real host, a real claude and a real codex.
 *
 *   node scripts/keeper-children-integration.mjs [--no-build] [--no-codex] [--no-claude]
 *
 * Builds like `keeper-integration.mjs` (cargo build into a target folder under /tmp, never
 * `tauri build`; `pnpm bundle:host`) and runs `centralu --keeper` against a temporary
 * `CC_DATA_DIR`, with a scratch git folder under /tmp as the project. Models are the cheap ones:
 * claude `haiku`, codex `gpt-5.6-luna` at low effort. It costs a few cents of model use.
 *
 * Checked:
 *   - a claude turn in progress survives the host being SIGKILLed: the new host re-attaches, and
 *     the rest of the turn and its result land in the store;
 *   - a terminal survives the same crash with its id and screen, and is resized after it;
 *   - a dev server (a project command) keeps running under the same run id, its log still growing;
 *   - a codex turn in progress survives a build switch (the blue-green swap of step 3: the old host
 *     drains and detaches, the new one re-attaches);
 *   - stop ("Quit and stop agents") ends every child the keeper held.
 *
 * `--no-claude --no-codex` leaves the parts that need no model and no network: the terminal and the
 * dev server across a host crash, and stop. CI runs exactly that (the `keeper` job in
 * `.github/workflows/build.yml`); the agent parts stay a manual run.
 *
 * Every process it starts, and everything those start, is killed before it exits, pass or fail
 * (`keeper-test-processes.mjs`); a failed run prints the end of the keeper's and the host's logs.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupOnExit, killFamily, once, printLogTails } from './keeper-test-processes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = process.env.KEEPER_TARGET_DIR || '/tmp/centralu-keeper-target'
const BIN = join(TARGET, 'debug', 'centralu')
const HOST_SRC = join(ROOT, 'apps/desktop/src-tauri/resources/host')
const FAKE_BUNDLE = '/tmp/centralu-keeper-test/Centralu.app'
const WITH_CLAUDE = !process.argv.includes('--no-claude')
const WITH_CODEX = !process.argv.includes('--no-codex')

const started = new Set()
const tempDirs = []
const heldPids = new Set()
let failures = 0

const log = (msg) => process.stdout.write(`${msg}\n`)
function check(cond, what, detail = '') {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
  }
  return cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs, stepMs = 200) {
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

/** One request, one answer line, on a fresh connection to a keeper socket */
function request(sock, body, timeoutMs = 8000) {
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
      const lines = buf.split('\n')
      for (const l of lines.slice(0, -1)) {
        const v = JSON.parse(l)
        // The child socket answers hello first; the request after it carries a rid
        if (body.op === 'hello' && v.rid === undefined && v.keeperPid) {
          c.write(`${JSON.stringify({ op: 'list', rid: 1 })}\n`)
          continue
        }
        clearTimeout(timer)
        c.end()
        return resolve(v)
      }
      buf = lines.at(-1)
    })
    c.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
const status = (sock) => request(sock, { op: 'status' }).then((r) => r.view)
/** What the keeper holds, from its child socket */
const heldChildren = (data) => request(join(data, 'children.sock'), { op: 'hello', protocol: 1 }).then((r) => r.children ?? [])

function startKeeper(data) {
  const logFd = openSync(join(data, 'keeper.log'), 'a')
  const child = spawn(
    BIN,
    ['--keeper', '--data-dir', data, '--host-source', HOST_SRC, '--bundle-path', FAKE_BUNDLE, '--app-version', '0.0.0-test'],
    { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, CC_DATA_DIR: data } },
  )
  started.add(child.pid)
  return { pid: child.pid }
}

/** A stand-in for the app, attached until killed */
function attachClient(sock) {
  const code = `
    const c = require('node:net').createConnection(${JSON.stringify(sock)})
    c.on('connect', () => c.write(JSON.stringify({ op: 'attach', protocol: 1 }) + '\\n'))
    c.on('close', () => process.exit(0))
    setInterval(() => {}, 1 << 30)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  started.add(child.pid)
  return child
}

/** A WebSocket client of the host: RPC calls, and every event and terminal frame it is sent */
async function hostClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  const frames = []
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
      } else if (f.kind === 'event') events.push(f.event)
      else if (f.kind === 'term') frames.push(f)
    }
    ws.onerror = () => reject(new Error('websocket error'))
  })
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the host closed the connection'))
    pending.clear()
  }
  return {
    events,
    frames,
    screen: (terminalId) => frames.filter((f) => f.terminalId === terminalId).map((f) => f.data).join(''),
    call: (method, params, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const id = String(next++)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, timeoutMs)
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

/** The host ready under a new pid, or undefined: at once if the keeper has given up on it */
async function readyView(sock, notPid) {
  let gaveUp = false
  const view = await waitFor(async () => {
    const v = await status(sock)
    // Five failed starts take the keeper about 11 s; waiting out the minute after that only delays the report
    if (v?.status?.state === 'failed') return (gaveUp = true)
    return v?.status?.state === 'ready' && v.hostPid && v.hostPid !== notPid && v
  }, 60_000, 250)
  return gaveUp ? undefined : view
}

const session = async (host, id) => (await host.call('sessions.list', {})).find((s) => s.id === id)
const transcript = async (host, id) => JSON.stringify(await host.call('messages.load', { sessionId: id, limit: 400 }))
/** Each tool call and result recorded once: nothing lost or doubled across the restart */
async function recordedOnce(host, id) {
  const rows = await host.call('messages.load', { sessionId: id, limit: 400 })
  const ids = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.payload?.callId)
  const calls = ids('tool_call')
  const results = ids('tool_result')
  const unique = (a) => new Set(a).size === a.length
  return { ok: unique(calls) && unique(results) && calls.length === results.length && calls.length > 0, calls: calls.length, results: results.length }
}
const toolResults = (host, id) => host.events.filter((e) => e.type === 'tool_result' && e.sessionId === id).length

const STEPS = (n) =>
  `Run these ${n} shell commands one at a time, each as its own separate tool call, waiting for each to finish before starting the next: ` +
  Array.from({ length: n }, (_, i) => `\`sleep 4; echo step${i + 1}\``).join(', ') +
  '. Do not combine them. After the last one, reply with exactly DONE.'

async function scenario() {
  const data = mkdtempSync('/tmp/ckc-')
  tempDirs.push(data)
  const project = mkdtempSync('/tmp/ckc-proj-')
  tempDirs.push(project)
  execFileSync('git', ['init', '-q'], { cwd: project })
  const sock = join(data, 'keeper.sock')
  const keeper = startKeeper(data)
  let view = await readyView(sock)
  if (!check(view, 'the keeper brings the host up', existsSync(join(data, 'keeper.log')) ? readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000) : '')) return
  const app = attachClient(sock)
  await sleep(500)
  await request(sock, { op: 'set_background', on: true })
  check(existsSync(join(data, 'children.sock')), 'the keeper serves its child socket')

  let host = await hostClient(view.status.port, view.status.token)
  const p = await host.call('projects.add', { path: project })

  // A terminal, with something on its screen
  log('\na terminal and a dev server')
  const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'echo T$((6*7))\n' })
  check(await waitFor(() => host.screen(term.terminalId).includes('T42'), 15_000), 'the terminal runs a command', host.screen(term.terminalId).slice(-300))

  // A dev server
  const cmd = `node -e "let i=0;setInterval(()=>console.log('tick '+(i++)),300)"`
  const run = await host.call('commands.run', { projectId: p.id, command: cmd })
  check(await waitFor(async () => (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history.includes('tick 3'), 15_000), 'the dev server prints')

  let held = await heldChildren(data)
  check(
    held.some((c) => c.tag?.kind === 'terminal' && c.tag.id === term.terminalId) && held.some((c) => c.tag?.kind === 'command' && c.tag.runId === run.runId),
    'the keeper, not the host, holds the terminal and the dev server',
    JSON.stringify(held.map((c) => c.tag)),
  )
  for (const c of held) heldPids.add(c.pid)

  // A claude turn in progress
  let claudeId = null
  if (WITH_CLAUDE) {
    log('\na claude turn across a host crash')
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    claudeId = s.id
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
    const firstResult = await waitFor(() => toolResults(host, claudeId) >= 1, 90_000, 250)
    check(firstResult, 'the claude turn is under way (first tool result)')
    held = await heldChildren(data)
    const claudeChild = held.find((c) => c.tag?.kind === 'agent' && c.tag.sessionId === claudeId)
    check(claudeChild?.alive, 'the keeper holds the claude process', JSON.stringify(held.map((c) => c.tag)))
    if (claudeChild) heldPids.add(claudeChild.pid)
  }

  // Crash: the host is SIGKILLed mid-turn
  const oldHost = view.hostPid
  host.close()
  process.kill(oldHost, 'SIGKILL')
  view = await readyView(sock, oldHost)
  if (!check(view, 'the keeper restarts a crashed host')) return
  host = await hostClient(view.status.port, view.status.token)

  if (claudeId) {
    const back = await waitFor(async () => (await session(host, claudeId))?.live && (await session(host, claudeId)), 30_000)
    check(back, 'the new host re-attached the claude session as live', JSON.stringify(await session(host, claudeId).catch(() => null)))
    const done = await waitFor(async () => {
      const t = await transcript(host, claudeId)
      return t.includes('step4') && /DONE/.test(t) && t
    }, 120_000, 1000)
    check(done, 'the rest of the claude turn and its result arrive through the new host', (await transcript(host, claudeId)).slice(-800))
    const once = await recordedOnce(host, claudeId)
    check(once.ok, 'every tool call and result of that turn is recorded exactly once', JSON.stringify(once))
    const settled = await waitFor(async () => {
      const s = await session(host, claudeId)
      return s && s.state !== 'working' && s
    }, 30_000, 500)
    check(settled, 'the session settles once the turn ends', (await session(host, claudeId))?.state)
  }

  log('\nthe terminal and the dev server after the crash')
  const terms = await host.call('terminal.list', { projectId: p.id })
  const t2 = terms.terminals.find((t) => t.terminalId === term.terminalId)
  check(t2?.alive, 'the terminal is still there under its id', JSON.stringify(terms))
  check(t2?.history?.includes('T42') ?? false, 'its screen came back from the keeper', (t2?.history ?? '').slice(-300))
  await host.call('terminal.resize', { terminalId: term.terminalId, cols: 132, rows: 50 })
  await sleep(300)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'stty size\n' })
  check(await waitFor(() => host.screen(term.terminalId).includes('50 132'), 10_000), 'and is resized after the restart', host.screen(term.terminalId).slice(-300))
  const runs = (await host.call('commands.state', { projectId: p.id })).runs
  const r2 = runs.find((r) => r.command === cmd)
  check(r2?.running && r2.runId === run.runId, 'the dev server is still running under the same run id', JSON.stringify(runs))
  const logA = (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history ?? ''
  await sleep(1200)
  const logB = (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history ?? ''
  check(logB.length > logA.length && /tick \d+/.test(logB), 'and its log keeps growing')

  // A codex turn in progress, across a build switch (TERM: the host detaches)
  if (WITH_CODEX) {
    log('\na codex turn across a build switch')
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'codex', model: 'gpt-5.6-luna', effort: 'low', permissionPreset: 'auto' })
    const codexId = s.id
    await host.call('agents.send', { sessionId: codexId, text: STEPS(3) })
    check(await waitFor(() => toolResults(host, codexId) >= 1, 120_000, 250), 'the codex turn is under way (first tool result)')
    held = await heldChildren(data)
    const codexChild = held.find((c) => c.tag?.kind === 'agent' && c.tag.sessionId === codexId)
    check(codexChild?.alive, 'the keeper holds codex app-server', JSON.stringify(held.map((c) => c.tag)))
    if (codexChild) heldPids.add(codexChild.pid)
    const before = view.hostPid
    check((await status(sock))?.keepsAgents === true, 'the host tells the keeper a switch keeps its agents')
    host.close()
    const sw = await request(sock, { op: 'switch', source: { commit: view.source?.commit ?? 'dev', hostDir: HOST_SRC, bundlePath: FAKE_BUNDLE } })
    check(sw.ok, 'a build switch is accepted', JSON.stringify(sw))
    view = await readyView(sock, before)
    if (!check(view, 'the switched host comes up')) return
    // A switch is a blue-green swap (step 3): the old host drains, detaches and hands over
    check(readFileSync(join(data, 'host.log'), 'utf8').includes(`[agent-host] drained (pid ${before})`), 'the old host drained and detached instead of stopping its children')
    host = await hostClient(view.status.port, view.status.token)
    check(await waitFor(async () => (await session(host, codexId))?.live, 30_000), 'the new host re-attached the codex session as live')
    const done = await waitFor(async () => {
      const t = await transcript(host, codexId)
      return t.includes('step3') && /DONE/.test(t) && t
    }, 150_000, 1000)
    check(done, 'the rest of the codex turn arrives through the new host', (await transcript(host, codexId)).slice(-800))
    const once = await recordedOnce(host, codexId)
    check(once.ok, 'every tool call and result of that turn is recorded exactly once', JSON.stringify(once))
    check(codexChild && alive(codexChild.pid), 'codex is the same process it was before the switch')
  }

  // Stop: everything the keeper held ends
  log('\nquit and stop agents')
  held = await heldChildren(data)
  for (const c of held) if (c.alive) heldPids.add(c.pid)
  const pids = [...heldPids]
  host.close()
  const stop = await request(sock, { op: 'stop' })
  check(stop.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(keeper.pid) && pids.every((pid) => !alive(pid)), 20_000, 250)
  check(gone, `stop ends the keeper and all ${pids.length} children it held`, pids.filter(alive).map((pid) => `${pid} still alive`).join(', '))
  check(readFileSync(join(data, 'host.log'), 'utf8').includes('stopped)'), 'the host stopped its children itself first')
  app.kill('SIGKILL')
}

const cleanup = once((threw) => {
  if (failures > 0 || threw) printLogTails(tempDirs, log)
  killFamily([...started, ...heldPids])
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
  await scenario()
}

cleanupOnExit(cleanup, log)
try {
  await main()
} catch (e) {
  failures++
  log(`\nerror: ${e?.stack ?? e}`)
} finally {
  cleanup()
}
log(failures === 0 ? '\nall keeper child checks passed' : `\n${failures} keeper child check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
