/**
 * A-5 smoke test: verifies the host end-to-end against a real Codex session.
 *
 * S9 — approval request → allow → the file is actually created (checks whether this overrides the
 *   global approval_policy="never")
 * S10 — remembers the earlier context via thread/resume after the host restarts
 * S11 — zombie check: killing the host leaves no codex app-server behind either
 *
 * Model: Codex's default model (do not use a top-tier model for verification — per the docs' model
 * policy)
 * Run with: node packages/agent-host/scripts/smoke-codex.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'smoke-codex'
const DB = join(mkdtempSync(join(tmpdir(), 'cc-codex-')), 'store.db')
const CWD = mkdtempSync(join(tmpdir(), 'cc-codex-cwd-'))
const log = (...a) => console.log('[codex]', ...a)

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

function startHost() {
  const host = spawn(
    'node',
    ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', DB],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('host startup timeout')), 20000)
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.ready) { clearTimeout(t); resolve({ host, port: j.port }) }
        } catch { /* log line */ }
      }
    })
  })
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  let id = 0
  let helloOk = () => {}
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.kind === 'res') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc failure'))
    } else if (m.kind === 'event') events.push(m.event)
    else if (m.kind === 'hello_ok') helloOk()
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
      setTimeout(() => pending.has(rid) && reject(new Error(`${method} timeout`)), 180000)
    })
  return { ws, call, events, ready }
}

const waitFor = (events, pred, ms = 180000, what = 'event') =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const t = setInterval(() => {
      const hit = events.find(pred)
      if (hit) { clearInterval(t); resolve(hit) }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error(`${what} wait timeout`)) }
    }, 200)
  })

const textOf = (events) => events.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')

// ── First run: approval round trip (S9) ──────────────────────────────────────────────
const first = await startHost()
const c1 = connect(first.port)
await c1.ready

const detected = await c1.call('agents.detect', {})
const codexInfo = detected.find((d) => d.tool === 'codex')
check(codexInfo?.installed === true, 'Codex detected', codexInfo?.detail)

const project = await c1.call('projects.add', { path: CWD })
const session = await c1.call('agents.createSession', {
  projectId: project.id, cwd: CWD, tool: 'codex', permissionPreset: 'safe',
  initialPrompt: 'Create a file named codex-ok.txt containing exactly: OK. Remember the codeword MELON. Then stop.',
})
check(!!session.externalId, 'thread id captured immediately on creation', session.externalId ?? 'none')

const approval = await waitFor(c1.events, (e) => e.type === 'approval_request', 180000, 'approval request')
check(true, 'S9 approval request received (session-level override of the global never)', approval.detail.kind)

await c1.call('agents.respondApproval', {
  sessionId: session.id, requestId: approval.requestId, decision: 'allow',
})
await waitFor(c1.events, (e) => e.type === 'turn_complete', 180000, 'turn complete')
check(existsSync(join(CWD, 'codex-ok.txt')), 'S9 file actually created after approval')

// FR-18 is satisfied by naming the session from its first prompt. Codex's thread/name/updated is
// a bonus, and does not arrive for a short session (measured). Checks whether a name actually got attached.
const named = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
// '새 세션' is the literal default session name from agent-host/src/sessions (out of this
// branch's scope, still Korean there) — kept as-is because it is the value being compared against.
check(!!named?.name && named.name !== '새 세션', 'FR-18 automatic session name', named?.name?.slice(0, 40))
const titleEvent = c1.events.find((e) => e.type === 'session_title')
log(titleEvent ? `· Codex title event also received: ${titleEvent.title}` : '· No Codex title event arrived (short session)')
const ctx = c1.events.find((e) => e.type === 'context_update' || e.type === 'usage_update')
check(!!ctx, 'token/context gauge event received', ctx?.type)

// ── Second run: resume after restart (S10) ────────────────────────────────────────
c1.ws.close()
first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))

const second = await startHost()
const c2 = connect(second.port)
await c2.ready
const res = await c2.call('agents.resumeSession', { sessionId: session.id })
check(res.resumed === true, 'S10 resume succeeded', res.reason ?? '')

if (res.resumed) {
  await c2.call('agents.send', { sessionId: session.id, text: 'What was the codeword? Reply with only that word.' })
  await waitFor(c2.events, (e) => e.type === 'turn_complete', 180000, 'turn after resume')
  const answer = textOf(c2.events).trim()
  check(/MELON/i.test(answer), 'S10 resumed session remembers earlier context', answer.slice(0, 40))
}

// ── Third run: zombie check (S11) ─────────────────────────────────────────────
c2.ws.close()
second.host.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 3000))
let leftover = ''
try {
  leftover = execSync('pgrep -f "codex app-server" || true', { encoding: 'utf8' }).trim()
} catch { /* no pgrep */ }
check(leftover === '', 'S11 killing the host leaves no codex app-server behind', leftover || 'none')

log(failures === 0 ? 'all passed' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
