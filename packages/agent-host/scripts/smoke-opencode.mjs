/**
 * OpenCode through the ACP adapter, end to end on a real host and the installed OpenCode CLI (docs/plans/acp-adapter.md §7):
 *
 *   O1  the tool is detected and installed
 *   O2  an untrusted project is refused before any process starts (`launchRefusal`)
 *   O3  a turn under Safe in a trusted project: the command's card, allowed, then its output reads back ok; the context
 *       share is read from OpenCode's `usage_update`
 *   O4  the host restarts and the next message opens the conversation again (`session/load`) and remembers it
 *   O5  killing the host leaves no `opencode acp` of this run behind
 *
 * Runs on OpenCode's default model (its own free one needs no account). Never touches the real data folder: the host runs
 * with a temporary `CC_DATA_DIR` and `--db`, and OpenCode with temporary XDG folders, so its settings and conversations
 * are this run's. It counts and stops only the agent processes its own hosts started. Run with:
 * node packages/agent-host/scripts/smoke-opencode.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { agentProcesses, processes } from './smoke-processes.mjs'

const TOKEN = 'smoke-opencode'
const DATA = mkdtempSync(join(tmpdir(), 'cc-opencode-data-'))
const DB = join(DATA, 'store.db')
const TRUSTED = realpathSync(mkdtempSync(join(tmpdir(), 'cc-opencode-cwd-')))
const UNTRUSTED = realpathSync(mkdtempSync(join(tmpdir(), 'cc-opencode-untrusted-')))
const TOOL = 'opencode'
const XDG = Object.fromEntries(['CONFIG', 'DATA', 'STATE', 'CACHE'].map((k) => [`XDG_${k}_HOME`, join(DATA, 'opencode-xdg', k.toLowerCase())]))
for (const dir of Object.values(XDG)) mkdirSync(dir, { recursive: true })
const OPENCODE_LOG = join(XDG.XDG_DATA_HOME, 'opencode', 'log', 'opencode.log')
const log = (...a) => console.log('[opencode]', ...a)

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' - ' + extra : ''}`)
  if (!ok) failures++
}

/** The hosts this run started: a run that fails part way stops them, and their agents, as it exits */
const hosts = []
process.on('exit', () => {
  for (const host of hosts) {
    const agents = acpPidsOf(host.pid)
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
    for (const pid of agents) {
      try {
        process.kill(Number(pid))
      } catch {
        /* already gone */
      }
    }
  }
})

function startHost() {
  const host = spawn(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', DB], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...XDG, CC_DATA_DIR: DATA },
  })
  hosts.push(host)
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
  // Resolved by the event itself; the bound only ends a run whose CLI stopped answering, with what OpenCode logged
  const next = (pred, what, ms = 300_000) =>
    new Promise((resolve, reject) => {
      const seen = events.find(pred)
      if (seen) return resolve(seen)
      const timer = setTimeout(() => reject(new Error(`no ${what} in ${ms} ms${openCodeError()}`)), ms)
      waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) })
    })
  return { ws, call, events, ready, next }
}

const textOf = (events, sessionId) => events.filter((e) => e.sessionId === sessionId && e.type === 'message_delta').map((e) => e.text).join('')

/**
 * The last error OpenCode logged in this run's folders, as a reason: a turn its model's provider refused (its free
 * models' usage limit) is retried inside OpenCode, which sends no ACP frame meanwhile, so the run sees only silence
 */
function openCodeError() {
  if (!existsSync(OPENCODE_LOG)) return ''
  const last = readFileSync(OPENCODE_LOG, 'utf8').split('\n').filter((l) => /level=ERROR/.test(l)).at(-1)
  const said = last?.match(/error\.error="([^"]*)"/)?.[1] ?? last
  return said ? `; OpenCode logged: ${said.slice(0, 200)}` : ''
}

/**
 * The `opencode acp` processes of this run still running: the descendants of a host it started, read while that host
 * runs (a killed host's children keep its pid as their parent's), and those seen before; its host watch is not one
 * (`agentProcesses`). Never another on the machine
 */
const ours = new Set()
function acpPidsOf(hostPid) {
  const all = processes()
  const tree = new Set([String(hostPid)])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) (tree.add(p.pid), (grew = true))
  }
  for (const p of agentProcesses(all, (cmd) => /opencode/i.test(cmd) && /\bacp\b/.test(cmd))) if (tree.has(p.pid)) ours.add(p.pid)
  const alive = new Set(all.map((p) => p.pid))
  return [...ours].filter((pid) => alive.has(pid))
}

const first = await startHost()
const c1 = connect(first.port)
await c1.ready

const detected = await c1.call('agents.detect', {})
const tool = detected.find((d) => d.name === TOOL)
check(!!tool && tool.installed, 'O1 OpenCode detected and installed', tool?.detail ?? 'not registered')

const untrusted = await c1.call('projects.add', { path: UNTRUSTED })
const refusedTrust = await c1.call('agents.createSession', { projectId: untrusted.id, cwd: UNTRUSTED, tool: TOOL }).then(() => null, (e) => e.message)
check(/trusted projects/.test(refusedTrust ?? ''), 'O2 an untrusted project is refused with the reason', refusedTrust ?? 'it started')
check(acpPidsOf(first.host.pid).length === 0, 'O2 no agent process was started for a refused launch')

const project = await c1.call('projects.add', { path: TRUSTED })
await c1.call('projects.setTrusted', { projectId: project.id, trusted: true })
const session = await c1.call('agents.createSession', {
  projectId: project.id,
  cwd: TRUSTED,
  tool: TOOL,
  permissionPreset: 'safe',
  initialPrompt: 'Remember the code word: heron. Run the shell command: echo smoke-opencode-1 . Then say done.',
})
const card = await c1.next((e) => e.sessionId === session.id && e.type === 'approval_request', 'approval card')
check(/smoke-opencode-1/.test(JSON.stringify(card.detail)), 'O3 Safe asks before the command, and the card names it', JSON.stringify(card.detail).slice(0, 80))
await c1.call('agents.respondApproval', { sessionId: session.id, requestId: card.requestId, decision: 'allow' })
await c1.next((e) => e.sessionId === session.id && e.type === 'turn_complete', 'turn end')
const result = c1.events.find((e) => e.sessionId === session.id && e.type === 'tool_result' && /smoke-opencode-1/.test(e.output ?? e.summary ?? ''))
check(!!result && result.ok, 'O3 the command ran and its output reads back ok', result ? `ok=${result.ok}` : 'no result with its output')
check(c1.events.some((e) => e.sessionId === session.id && e.type === 'context_update'), 'O3 the context share is read (usage_update)')
check(acpPidsOf(first.host.pid).length === 1, 'O3 one agent process for the session')

first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))
check(acpPidsOf(first.host.pid).length === 0, 'O4 a host that stops ends its agent process')

const second = await startHost()
const c2 = connect(second.port)
await c2.ready
await c2.call('agents.resumeSession', { sessionId: session.id }).catch(() => null)
await c2.call('agents.send', { sessionId: session.id, text: 'What was the code word? Reply with that word only.' })
await c2.next((e) => e.sessionId === session.id && e.type === 'turn_complete', 'resumed turn end')
check(/heron/i.test(textOf(c2.events, session.id)), 'O4 the reopened conversation remembers it', textOf(c2.events, session.id).slice(0, 80))

acpPidsOf(second.host.pid)
second.host.kill('SIGKILL')
await new Promise((r) => second.host.once('exit', r))
const left = []
for (let i = 0; i < 20 && (left.length = 0, left.push(...acpPidsOf(second.host.pid)), left.length); i++) await new Promise((r) => setTimeout(r, 500))
check(left.length === 0, 'O5 killing the host leaves no agent process of this run behind', left.join(',') || 'none')
for (const pid of left) {
  try {
    process.kill(Number(pid))
  } catch {
    /* already gone */
  }
}

log(failures === 0 ? 'all passed' : `${failures} failed`, `(data folder ${DATA})`)
process.exit(failures === 0 ? 0 : 1)
