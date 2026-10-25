/**
 * Cursor through the ACP adapter, end to end on a real host and the installed Cursor CLI (docs/plans/acp-adapter.md §0):
 *
 *   C1  the tool is detected, installed and logged in
 *   C2  refused before any process starts: an untrusted project, and Safe and Normal (Cursor writes without asking, so it
 *       runs under Auto only, `launchRefusal`)
 *   C3  a turn under Auto in a trusted project: the command runs with no card, its output reads back, and no context
 *       share is claimed
 *   C4  the host restarts and the next message opens the conversation again (`session/load`) and remembers it
 *   C5  killing the host leaves no `agent acp` of this run behind
 *
 * Spends a few calls of the person's Cursor plan on its default model. Never touches the real data folder: the host runs
 * with a temporary `CC_DATA_DIR` and `--db`. Run with: node packages/agent-host/scripts/smoke-cursor.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { agentProcesses, processes } from './smoke-processes.mjs'

const TOKEN = 'smoke-cursor'
const DATA = mkdtempSync(join(tmpdir(), 'cc-cursor-data-'))
const DB = join(DATA, 'store.db')
const TRUSTED = realpathSync(mkdtempSync(join(tmpdir(), 'cc-cursor-cwd-')))
const UNTRUSTED = realpathSync(mkdtempSync(join(tmpdir(), 'cc-cursor-untrusted-')))
const TOOL = 'cursor-agent'
const log = (...a) => console.log('[cursor]', ...a)

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' - ' + extra : ''}`)
  if (!ok) failures++
}

function startHost() {
  const host = spawn(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', DB], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CC_DATA_DIR: DATA },
  })
  return new Promise((resolve, reject) => {
    host.on('exit', (code) => reject(new Error(`host exited before ready (${code})`)))
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        try {
          const j = JSON.parse(line)
          if (j.ready) resolve({ host, port: j.port })
        } catch {
          /* a log line */
        }
      }
    })
  })
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  const waiters = []
  let id = 0
  let helloOk = () => {}
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.kind === 'res') {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc failure'))
    } else if (m.kind === 'event') {
      events.push(m.event)
      for (const w of [...waiters]) if (w.pred(m.event)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(m.event)
    } else if (m.kind === 'hello_ok') helloOk()
  })
  const ready = new Promise((resolve) => {
    helloOk = resolve
    ws.once('open', () => ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 })))
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = String(++id)
      pending.set(rid, { resolve, reject })
      ws.send(JSON.stringify({ kind: 'rpc', id: rid, method, params }))
    })
  // Resolved by the event itself; the bound only ends a run whose CLI stopped answering
  const next = (pred, what, ms = 240_000) =>
    new Promise((resolve, reject) => {
      const seen = events.find(pred)
      if (seen) return resolve(seen)
      const timer = setTimeout(() => reject(new Error(`no ${what} in ${ms} ms`)), ms)
      waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) })
    })
  return { ws, call, events, ready, next }
}

const textOf = (events, sessionId) => events.filter((e) => e.sessionId === sessionId && e.type === 'message_delta').map((e) => e.text).join('')

/**
 * The `agent acp` processes running now, as pids; `index.js acp` is how the adapter starts it. Its host watch is not one
 * (`agentProcesses`)
 */
const acpPids = () => agentProcesses(processes(), (cmd) => /cursor-agent.* acp/.test(cmd)).map((p) => p.pid)

const before = new Set(acpPids())
const first = await startHost()
const c1 = connect(first.port)
await c1.ready

const detected = await c1.call('agents.detect', {})
const cursor = detected.find((d) => d.name === TOOL)
check(!!cursor && cursor.installed && cursor.loggedIn, 'C1 Cursor detected, installed and logged in', cursor?.detail ?? 'not registered')

const untrusted = await c1.call('projects.add', { path: UNTRUSTED })
const refusedTrust = await c1.call('agents.createSession', { projectId: untrusted.id, cwd: UNTRUSTED, tool: TOOL }).then(() => null, (e) => e.message)
check(/trusted projects/.test(refusedTrust ?? ''), 'C2 an untrusted project is refused with the reason', refusedTrust ?? 'it started')

const project = await c1.call('projects.add', { path: TRUSTED })
await c1.call('projects.setTrusted', { projectId: project.id, trusted: true })
const refusedSafe = await c1.call('agents.createSession', { projectId: project.id, cwd: TRUSTED, tool: TOOL, permissionPreset: 'safe' }).then(() => null, (e) => e.message)
check(/Safe/.test(refusedSafe ?? ''), 'C2 the Safe preset is refused with the reason', refusedSafe ?? 'it started')
const refusedNormal = await c1.call('agents.createSession', { projectId: project.id, cwd: TRUSTED, tool: TOOL, permissionPreset: 'normal' }).then(() => null, (e) => e.message)
check(/Normal.*only under Auto/.test(refusedNormal ?? ''), 'C2 the Normal preset is refused with the reason', refusedNormal ?? 'it started')
check(acpPids().filter((p) => !before.has(p)).length === 0, 'C2 no agent process was started for a refused launch')

const session = await c1.call('agents.createSession', {
  projectId: project.id,
  cwd: TRUSTED,
  tool: TOOL,
  permissionPreset: 'auto',
  initialPrompt: 'Remember the code word: heron. Run the shell command: echo smoke-cursor-1 . Then say done.',
})
await c1.next((e) => e.sessionId === session.id && e.type === 'turn_complete', 'turn end')
check(!c1.events.some((e) => e.sessionId === session.id && e.type === 'approval_request'), 'C3 Auto asks nothing')
const result = c1.events.find((e) => e.sessionId === session.id && e.type === 'tool_result' && /smoke-cursor-1/.test(e.output ?? e.summary ?? ''))
check(!!result && result.ok, 'C3 the command ran and its output reads back', result ? `ok=${result.ok} ${JSON.stringify(result.summary).slice(0, 60)}` : 'no result with its output')
check(!c1.events.some((e) => e.sessionId === session.id && e.type === 'context_update'), 'C3 no context share is claimed (Cursor sends no usage_update)')
check(acpPids().filter((p) => !before.has(p)).length === 1, 'C3 one agent process for the session')

first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))
check(acpPids().filter((p) => !before.has(p)).length === 0, 'C4 a host that stops ends its agent process')

const second = await startHost()
const c2 = connect(second.port)
await c2.ready
await c2.call('agents.resumeSession', { sessionId: session.id }).catch(() => null)
await c2.call('agents.send', { sessionId: session.id, text: 'What was the code word? Reply with that word only.' })
await c2.next((e) => e.sessionId === session.id && e.type === 'turn_complete', 'resumed turn end')
check(/heron/i.test(textOf(c2.events, session.id)), 'C4 the reopened conversation remembers it', textOf(c2.events, session.id).slice(0, 80))

second.host.kill('SIGKILL')
await new Promise((r) => second.host.once('exit', r))
const left = []
for (let i = 0; i < 20 && (left.length = 0, left.push(...acpPids().filter((p) => !before.has(p))), left.length); i++) await new Promise((r) => setTimeout(r, 500))
check(left.length === 0, 'C5 killing the host leaves no agent process of this run behind', left.join(',') || 'none')
for (const pid of left) {
  try {
    process.kill(Number(pid))
  } catch {
    /* already gone */
  }
}

log(failures === 0 ? 'all passed' : `${failures} failed`, `(data folder ${DATA})`)
process.exit(failures === 0 ? 0 : 1)
