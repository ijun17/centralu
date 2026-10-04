#!/usr/bin/env node
/**
 * The keeper handing itself over to a new keeper (#280, option C step 4), end to end with real
 * binaries, the real host, a real claude and a real codex.
 *
 *   node scripts/keeper-handoff-integration.mjs [--no-build] [--no-codex] [--no-claude]
 *
 * Builds like the other keeper scripts (`cargo build` into a target folder under /tmp, never
 * `tauri build`; `pnpm bundle:host`), then makes three "builds" A, B and C under /tmp: each is its
 * own copy of the executable next to its own copy of the bundled host, stamped with its own commit
 * (`handoff-A`, ...). A keeper's build is the host folder it was started with, exactly as in the
 * app, where the executable and the host folder sit in one bundle. Everything runs against a
 * temporary `CC_DATA_DIR` and a scratch git folder; models are claude `haiku` and codex
 * `gpt-5.6-luna` at low effort.
 *
 * Every incoming keeper waits `CC_KEEPER_HANDOFF_HOLD_MS` (1.5 s) before saying ready, so the
 * freeze is long enough to be seen and so the failure case can kill one mid-handoff.
 *
 * Checked:
 *   - keeper A (build A) with its host, a terminal printing a counter, a dev server, a claude turn
 *     mid-tool-call and a codex turn, hands over to keeper B (`upgrade`): same host pid, same child
 *     pids, the counter and the dev server's ticks continuous (nothing lost or doubled), each
 *     agent's tool calls recorded once and its turn finished, the front door on the same port and
 *     token, the WebSocket opened before the handoff never closed and still answers, a new client
 *     connects, the attached window was never dropped and hears from B, `keeper.json` names B, A
 *     has exited, and `keeper.lock` is held by B (a third keeper is turned away);
 *   - an app view opened before the handoff (a user-folder app from the bundled template) is served
 *     at the same address through the front door after it, and again after the host swap below;
 *   - build A's executable is deleted and written anew while keeper A runs (what `tauri build` does
 *     to a bundle), and keeper A goes on serving and hands over from it;
 *   - B starting keeper C, killed before the commit: B rolls back and serves everything as before;
 *   - "Switch to this build" from build C (`switch` with `keeper`): the keeper moves to C and C
 *     swaps the host to build C, the terminal and dev server still the same processes;
 *   - stop ends the keeper, the host and every child.
 *
 * Every process it starts (keepers included, found in keeper.log) is killed before it exits.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = process.env.KEEPER_TARGET_DIR || '/tmp/centralu-keeper-target'
const BIN = join(TARGET, 'debug', 'centralu')
const HOST_SRC = join(ROOT, 'apps/desktop/src-tauri/resources/host')
const WITH_CLAUDE = !process.argv.includes('--no-claude')
const WITH_CODEX = !process.argv.includes('--no-codex')
const HOLD_MS = 1500

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
const heldChildren = (data) => request(join(data, 'children.sock'), { op: 'hello', protocol: 1 }).then((r) => r.children ?? [])

/** A "build": its own copy of the executable and of the host, stamped with its own commit */
function makeBuild(root, name) {
  const dir = join(root, name)
  const host = join(dir, 'host')
  cpSync(HOST_SRC, host, { recursive: true })
  const infoPath = join(host, 'bundle-info.json')
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  writeFileSync(infoPath, JSON.stringify({ ...info, commit: `handoff-${name}`, builtAt: new Date().toISOString() }))
  const exe = join(dir, 'centralu')
  cpSync(BIN, exe)
  return { name, exe, host, commit: `handoff-${name}`, bundle: join(dir, 'Centralu.app') }
}
/** A user-folder app with a home view: the bundled template, placeholders filled in */
function plantApp(data, id) {
  const dir = join(data, 'apps', id)
  cpSync(join(HOST_SRC, 'app-template'), dir, { recursive: true })
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) {
        if (f !== 'runtime') walk(p)
        continue
      }
      const text = readFileSync(p, 'utf8')
      if (text.includes('{{APP_')) writeFileSync(p, text.replaceAll('{{APP_ID}}', id).replaceAll('{{APP_NAME}}', 'Demo').replaceAll('{{APP_DESCRIPTION}}', 'demo'))
    }
  }
  walk(dir)
}
/** What the desktop webview's origin is; any allowed origin works for a client without an Origin header */
const VIEW_ORIGIN = 'tauri://localhost'
const viewFrame = (host, opened) => host.call('apps.viewFrame', { appId: 'demo', projectId: null, instanceId: opened.instanceId, hostOrigin: VIEW_ORIGIN })
const fetchStatus = (url) => fetch(url).then((r) => r.status).catch((e) => String(e))

const sourceOf = (b) => ({ commit: b.commit, hostDir: b.host, bundlePath: b.bundle, version: '0.0.0-test' })

function startKeeper(b, data, extraEnv = {}) {
  const logFd = openSync(join(data, 'keeper.log'), 'a')
  const child = spawn(
    b.exe,
    ['--keeper', '--data-dir', data, '--host-source', b.host, '--bundle-path', b.bundle, '--app-version', '0.0.0-test'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CC_DATA_DIR: data, CC_KEEPER_HANDOFF_HOLD_MS: String(HOLD_MS), ...extraEnv },
    },
  )
  started.add(child.pid)
  return child
}

/** Keeper pids the log names as successors: killed at the end like everything else */
function successorsInLog(data) {
  const text = existsSync(join(data, 'keeper.log')) ? readFileSync(join(data, 'keeper.log'), 'utf8') : ''
  return [...text.matchAll(/handing over to keeper pid (\d+)/g)].map((m) => Number(m[1]))
}

/** A stand-in for the app: attached until killed, writing every pushed line to a file */
function attachClient(sock, out) {
  const code = `
    const fs = require('node:fs')
    const c = require('node:net').createConnection(${JSON.stringify(sock)})
    c.on('connect', () => c.write(JSON.stringify({ op: 'attach', protocol: 1 }) + '\\n'))
    c.on('data', (d) => fs.appendFileSync(${JSON.stringify(out)}, d))
    c.on('close', () => { fs.appendFileSync(${JSON.stringify(out)}, '{"closed":true}\\n'); process.exit(0) })
    setInterval(() => {}, 1 << 30)
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  started.add(child.pid)
  return child
}

/** A WebSocket client of the host through the front door */
async function hostClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  const frames = []
  let closed = false
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
    closed = true
    for (const p of pending.values()) p.reject(new Error('the host closed the connection'))
    pending.clear()
  }
  return {
    events,
    frames,
    get closed() {
      return closed
    },
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

async function readyView(sock, notPid) {
  return waitFor(async () => {
    const v = await status(sock)
    return v?.status?.state === 'ready' && v.hostPid && v.hostPid !== notPid && v
  }, 60_000, 250)
}

const transcript = async (host, id) => JSON.stringify(await host.call('messages.load', { sessionId: id, limit: 400 }))
async function recordedOnce(host, id) {
  const rows = await host.call('messages.load', { sessionId: id, limit: 400 })
  const ids = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.payload?.callId)
  const calls = ids('tool_call')
  const results = ids('tool_result')
  const unique = (a) => new Set(a).size === a.length
  return { ok: unique(calls) && unique(results) && calls.length === results.length && calls.length > 0, calls: calls.length, results: results.length }
}
/**
 * The turn really ended: the last step's tool result is recorded and an assistant reply says DONE.
 * (The prompt itself contains both words, so searching the whole transcript proves nothing.)
 */
async function turnDone(host, id, n) {
  const rows = await host.call('messages.load', { sessionId: id, limit: 400 })
  const lastStep = rows.some((r) => r.kind === 'tool_result' && String(r.payload?.output ?? r.payload?.summary ?? '').includes(`step${n}`))
  const said = rows
    .filter((r) => r.role === 'assistant' && r.kind === 'text')
    .map((r) => r.payload?.text ?? '')
    .join('')
  return lastStep && /DONE/.test(said)
}
const toolResults = (host, id) => host.events.filter((e) => e.type === 'tool_result' && e.sessionId === id).length

const STEPS = (n) =>
  `Run these ${n} shell commands one at a time, each as its own separate tool call, waiting for each to finish before starting the next: ` +
  Array.from({ length: n }, (_, i) => `\`sleep 4; echo step${i + 1}\``).join(', ') +
  '. Do not combine them. After the last one, reply with exactly DONE.'

/** Numbers printed as `<tag> <n>` on their own lines, in order of appearance */
function numbers(text, tag) {
  return [...text.matchAll(new RegExp(`^${tag} (\\d+)\\r?$`, 'gm'))].map((m) => Number(m[1]))
}
/** Consecutive and each once: nothing lost or doubled */
function continuous(ns) {
  if (ns.length < 2) return { ok: false, why: `only ${ns.length} numbers` }
  for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) return { ok: false, why: `${ns[i - 1]} then ${ns[i]} at ${i}` }
  return { ok: true, why: `${ns[0]}..${ns.at(-1)}` }
}

/** A third keeper on the same folder: refused (exit 3) while someone holds the lock and answers */
function thirdKeeperRefused(b, data) {
  const r = spawnSync(b.exe, ['--keeper', '--data-dir', data, '--host-source', b.host], {
    env: { ...process.env, CC_DATA_DIR: data },
    timeout: 20_000,
    encoding: 'utf8',
  })
  return { refused: r.status === 3, status: r.status, out: (r.stderr || '').slice(-400) }
}

async function scenario() {
  const builds = mkdtempSync('/tmp/ckh-builds-')
  tempDirs.push(builds)
  const A = makeBuild(builds, 'A')
  const B = makeBuild(builds, 'B')
  const C = makeBuild(builds, 'C')
  const data = mkdtempSync('/tmp/ckh-')
  tempDirs.push(data)
  const project = mkdtempSync('/tmp/ckh-proj-')
  tempDirs.push(project)
  execFileSync('git', ['init', '-q'], { cwd: project })
  const sock = join(data, 'keeper.sock')
  const keeperLog = () => readFileSync(join(data, 'keeper.log'), 'utf8')
  plantApp(data, 'demo')

  log('\nkeeper A with a host, a terminal, a dev server and agents')
  const keeperA = startKeeper(A, data)
  let view = await readyView(sock)
  if (!check(view, 'keeper A brings the host up', existsSync(join(data, 'keeper.log')) ? keeperLog().slice(-2000) : '')) return
  check(view.keeper.build?.commit === 'handoff-A', 'keeper A says it is build A', JSON.stringify(view.keeper.build))
  // Background mode stays off: if the window's connection were dropped by the handoff, the next
  // keeper would see no window and stop everything
  const windowOut = join(data, 'window.jsonl')
  const app = attachClient(sock, windowOut)
  await waitFor(async () => (await status(sock))?.attached === 1, 5000)
  const door = { port: view.status.port, token: view.status.token }

  const host = await hostClient(door.port, door.token)
  const p = await host.call('projects.add', { path: project })
  const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term.terminalId, data: "i=0; while true; do echo \"C $i\"; i=$((i+1)); sleep 0.05; done\n" })
  check(await waitFor(() => numbers(host.screen(term.terminalId), 'C').length > 10, 15_000), 'the terminal counts', host.screen(term.terminalId).slice(-300))
  const cmd = `node -e "let i=0;setInterval(()=>console.log('tick '+(i++)),100)"`
  const run = await host.call('commands.run', { projectId: p.id, command: cmd })
  check(await waitFor(async () => (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history.includes('tick 5'), 15_000), 'the dev server ticks')
  const opened = await host.call('apps.openView', { appId: 'demo', projectId: null })
  const frame = await viewFrame(host, opened)
  check(new URL(frame.url).port === String(door.port), 'an app view is addressed through the front door')
  check((await fetchStatus(frame.url)) === 200, 'and its frame loads')

  let claudeId = null
  let codexId = null
  if (WITH_CLAUDE) {
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    claudeId = s.id
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
  }
  if (WITH_CODEX) {
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'codex', model: 'gpt-5.6-luna', effort: 'low', permissionPreset: 'auto' })
    codexId = s.id
    await host.call('agents.send', { sessionId: codexId, text: STEPS(3) })
  }
  if (claudeId) check(await waitFor(() => toolResults(host, claudeId) >= 1, 90_000, 250), 'the claude turn is under way (first tool result)')
  if (codexId) check(await waitFor(() => toolResults(host, codexId) >= 1, 120_000, 250), 'the codex turn is under way (first tool result)')

  const before = await heldChildren(data)
  for (const c of before) heldPids.add(c.pid)
  const hostPid = view.hostPid
  heldPids.add(hostPid)
  const livePids = before.filter((c) => c.alive).map((c) => c.pid)
  log(`  (host pid ${hostPid}; held ${before.map((c) => `${c.tag?.kind}:${c.pid}`).join(', ')})`)

  // ---- the bundle rewritten under a running keeper: delete, then write anew (tauri build's way)
  log('\nrewriting build A on disk while keeper A runs')
  rmSync(A.exe)
  cpSync(BIN, A.exe)
  await sleep(500)
  check(alive(keeperA.pid) && (await status(sock).catch(() => null))?.keeper?.pid === keeperA.pid, 'keeper A keeps running and answering from its unlinked executable')

  // ---- the handoff A -> B
  log('\nhanding keeper A over to keeper B')
  const up = await request(sock, { op: 'upgrade', exe: B.exe, source: sourceOf(B) })
  check(up.ok, 'the upgrade is accepted', JSON.stringify(up))
  const t0 = Date.now()
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.keeper?.pid !== keeperA.pid && v?.keeper?.build?.commit === 'handoff-B' && v
  }, 30_000, 100)
  for (const pid of successorsInLog(data)) started.add(pid)
  if (!check(view, 'keeper B answers on the same socket', keeperLog().slice(-2500))) return
  log(`  (handoff took ${Date.now() - t0} ms including the ${HOLD_MS} ms hold)`)
  const keeperB = view.keeper.pid
  check(await waitFor(() => !alive(keeperA.pid), 10_000), 'keeper A has exited')
  check(view.hostPid === hostPid, 'the host is the same process', `${hostPid} -> ${view.hostPid}`)
  check(alive(hostPid), 'and it is still running')
  check(view.status.port === door.port && view.status.token === door.token, 'the front door has the same port and token')
  check(view.source?.commit === 'handoff-A', 'the host is still build A (only the keeper moved)', view.source?.commit)
  check(view.attached === 1, 'keeper B counts the attached window', String(view.attached))
  const after = await heldChildren(data)
  check(
    livePids.every((pid) => after.some((c) => c.pid === pid && c.alive)),
    'every child is the same process, still alive, held by keeper B',
    JSON.stringify(after.map((c) => [c.pid, c.alive])),
  )
  check(!host.closed, 'the WebSocket opened before the handoff was never closed')
  check(Array.isArray(await host.call('sessions.list', {})), 'and it still answers RPCs')
  const fresh = await hostClient(door.port, door.token).catch(() => null)
  check(fresh, 'a new client connects through the front door')
  fresh?.close()
  check((await fetchStatus(frame.url)) === 200, 'the app view opened before the handoff still loads at the same address')
  check((await viewFrame(host, opened)).url === frame.url, 'and the host gives the same address for it')
  check(alive(app.pid) && !readFileSync(windowOut, 'utf8').includes('"closed"'), 'the attached window was never dropped')
  check(
    await waitFor(() => readFileSync(windowOut, 'utf8').includes(`"pid":${keeperB}`), 10_000),
    'and it hears from keeper B on the same connection',
  )
  const kj = JSON.parse(readFileSync(join(data, 'keeper.json'), 'utf8'))
  check(kj.pid === keeperB && kj.build?.commit === 'handoff-B', 'keeper.json names keeper B', JSON.stringify({ pid: kj.pid, build: kj.build?.commit }))
  check(readFileSync(join(data, 'keeper.lock'), 'utf8').trim() === String(keeperB), 'keeper.lock records keeper B')
  const third = thirdKeeperRefused(C, data)
  check(third.refused, 'a third keeper is turned away (B holds keeper.lock)', JSON.stringify(third))

  await sleep(2000)
  const counted = continuous(numbers(host.screen(term.terminalId), 'C'))
  check(counted.ok, `the terminal counter is continuous across the handoff (${counted.why})`)
  const history = (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history ?? ''
  const ticks = continuous(numbers(history, 'tick'))
  check(ticks.ok, `the dev server's ticks are continuous (${ticks.why})`)
  check((await host.call('commands.state', { projectId: p.id })).runs.find((r) => r.command === cmd)?.runId === run.runId, 'the dev server keeps its run id')

  if (claudeId) {
    const done = await waitFor(() => turnDone(host, claudeId, 4), 150_000, 1000)
    check(done, 'the claude turn finishes across the handoff', (await transcript(host, claudeId)).slice(-600))
    const once = await recordedOnce(host, claudeId)
    check(once.ok, 'each claude tool call and result is recorded once', JSON.stringify(once))
  }
  if (codexId) {
    const done = await waitFor(() => turnDone(host, codexId, 3), 180_000, 1000)
    check(done, 'the codex turn finishes across the handoff', (await transcript(host, codexId)).slice(-600))
    const once = await recordedOnce(host, codexId)
    check(once.ok, 'each codex tool call and result is recorded once', JSON.stringify(once))
  }

  // ---- a handoff that fails before the commit
  log('\nkeeper B handing over to keeper C, which is killed before the commit')
  const known = new Set(successorsInLog(data))
  const up2 = await request(sock, { op: 'upgrade', exe: C.exe, source: sourceOf(C) })
  check(up2.ok, 'the second upgrade is accepted')
  const victim = await waitFor(() => successorsInLog(data).find((pid) => !known.has(pid)), 10_000, 50)
  if (victim) started.add(victim)
  // Within the hold: C has the state but has not said ready
  await sleep(500)
  check(victim && alive(victim), 'keeper C is mid-handoff', String(victim))
  if (victim) process.kill(victim, 'SIGKILL')
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.swap?.phase === 'failed' && v
  }, 15_000, 100)
  check(view?.keeper?.pid === keeperB, 'keeper B is still the keeper', JSON.stringify(view?.keeper))
  check(view?.swap?.message?.includes('hand over'), 'the window is told the handoff failed', view?.swap?.message)
  check(view?.hostPid === hostPid && alive(hostPid), 'the host was not touched')
  const afterFail = await heldChildren(data)
  check(livePids.filter(alive).every((pid) => afterFail.some((c) => c.pid === pid)), 'keeper B still holds every child')
  check(!host.closed && Array.isArray(await host.call('sessions.list', {})), 'the WebSocket still works')
  check(alive(app.pid) && !readFileSync(windowOut, 'utf8').includes('"closed"'), 'the window is still attached')
  await sleep(1500)
  const counted2 = continuous(numbers(host.screen(term.terminalId), 'C'))
  check(counted2.ok, `the terminal counter is continuous across the rollback (${counted2.why})`)
  check(thirdKeeperRefused(C, data).refused, 'keeper B still holds keeper.lock')

  // ---- "Switch to this build" from build C: keeper first, then the host
  log('\nswitching everything to build C (keeper, then host)')
  const sw = await request(sock, { op: 'switch', source: sourceOf(C), keeper: { exe: C.exe } })
  check(sw.ok, 'the switch is accepted', JSON.stringify(sw))
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.keeper?.build?.commit === 'handoff-C' && v?.source?.commit === 'handoff-C' && v?.status?.state === 'ready' && v?.swap?.phase === 'done' && v
  }, 90_000, 250)
  for (const pid of successorsInLog(data)) started.add(pid)
  if (!check(view, 'the keeper and the host both end on build C', keeperLog().slice(-2500))) return
  heldPids.add(view.hostPid)
  check(view.hostPid !== hostPid, 'the host was swapped (a new host process)')
  check(await waitFor(() => !alive(keeperB), 10_000), 'keeper B has exited')
  check(view.status.port === door.port && view.status.token === door.token, 'the front door still has the same port and token')
  const termPid = before.find((c) => c.tag?.kind === 'terminal')?.pid
  check(termPid && alive(termPid), 'the terminal is still the same process')
  const h2 = await hostClient(door.port, door.token)
  const terms = await h2.call('terminal.list', { projectId: p.id })
  check(terms.terminals.some((t) => t.terminalId === term.terminalId && t.alive), 'the new host took the terminal over')
  check((await fetchStatus(frame.url)) === 200, 'the app view still loads at the same address after the host swap')
  check((await viewFrame(h2, opened).catch((e) => ({ url: String(e) }))).url === frame.url, 'and the new host gives the same address for it')

  // ---- stop
  log('\nquit and stop agents')
  const held = await heldChildren(data)
  for (const c of held) if (c.alive) heldPids.add(c.pid)
  const keeperC = view.keeper.pid
  const pids = [...heldPids].filter(alive)
  h2.close()
  host.close()
  const stop = await request(sock, { op: 'stop' })
  check(stop.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(keeperC) && pids.every((pid) => !alive(pid)), 20_000, 250)
  check(gone, `stop ends the keeper, the host and all ${pids.length} processes`, pids.filter(alive).map((pid) => `${pid} still alive`).join(', '))
  app.kill('SIGKILL')
}

function cleanup() {
  for (const pid of [...started, ...heldPids]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  if (process.env.KEEP_TEMP) log(`kept: ${tempDirs.join(" ")}`)
  else for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
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
  await scenario()
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
log(failures === 0 ? '\nall keeper handoff checks passed' : `\n${failures} keeper handoff check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
