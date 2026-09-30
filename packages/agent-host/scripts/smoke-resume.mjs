/**
 * M1.5 L3 smoke test: verifies **resume (FR-10)** end-to-end against a real Claude session.
 *
 * S5 — the same conversation continues even after the host is shut down and restarted (actually
 *   asks whether it remembers the earlier context)
 * S6 — if the resume identifier is broken, it fails with a reason instead of dying silently
 *
 * The verification model is haiku (per the docs' model policy: do not use a top-tier model for
 * verification).
 * Run with: node packages/agent-host/scripts/smoke-resume.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'smoke-resume'
const DB = join(mkdtempSync(join(tmpdir(), 'cc-resume-')), 'store.db') // The store shared by both host runs
const CWD = mkdtempSync(join(tmpdir(), 'cc-resume-cwd-'))
const log = (...a) => console.log('[resume]', ...a)

function startHost() {
  const host = spawn(
    'node',
    ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', DB],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('host 기동 타임아웃')), 20000)
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.ready) {
            clearTimeout(t)
            resolve({ host, port: j.port })
          }
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
  let id = 0
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.kind === 'res') {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc 실패'))
    } else if (m.kind === 'event') {
      events.push(m.event)
    } else if (m.kind === 'hello_ok') {
      helloOk()
    }
  })
  let helloOk = () => {}
  const ready = new Promise((resolve) => {
    helloOk = resolve
    ws.once('open', () => ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 })))
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = String(++id)
      pending.set(rid, { resolve, reject })
      ws.send(JSON.stringify({ kind: 'rpc', id: rid, method, params }))
      setTimeout(() => pending.has(rid) && reject(new Error(`${method} 타임아웃`)), 120000)
    })
  return { ws, call, events, ready }
}

const textOf = (events) =>
  events.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')

const waitFor = (events, pred, ms = 120000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const t = setInterval(() => {
      if (events.some(pred)) {
        clearInterval(t)
        resolve()
      } else if (Date.now() - started > ms) {
        clearInterval(t)
        reject(new Error('이벤트 대기 타임아웃'))
      }
    }, 200)
  })

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

// ── First host run: create a session and say something worth remembering ──────────────────
const first = await startHost()
const c1 = connect(first.port)
await c1.ready
const project = await c1.call('projects.add', { path: CWD })
const session = await c1.call('agents.createSession', {
  projectId: project.id, cwd: CWD, tool: 'claude', model: 'haiku', permissionPreset: 'safe',
  initialPrompt: 'Remember this codeword: PLUM. Reply with only: OK',
})
await waitFor(c1.events, (e) => e.type === 'turn_complete')
log('1차 응답:', JSON.stringify(textOf(c1.events).trim().slice(0, 60)))

// The SDK tells us the session id only in the first init event — it may not exist yet at the moment
// of the create response. What matters is that it is guaranteed to be saved once the first turn
// ends (otherwise resuming is impossible).
const afterFirstTurn = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
check(!!afterFirstTurn?.externalId, '첫 턴 후 재개 식별자가 저장된다', afterFirstTurn?.externalId ?? '없음')

// ── Shut down the host (simulating the user quitting and reopening the app) ─────────────────────────
c1.ws.close()
first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))
log('host 종료됨 — 프로세스는 사라지고 기록만 남았다')

// ── Second host run: start again against the same store and resume ─────────────────
const second = await startHost()
const c2 = connect(second.port)
await c2.ready

const restored = await c2.call('sessions.list', {})
const target = restored.find((s) => s.id === session.id)
check(!!target, '재시작 후에도 세션이 목록에 남는다')
check(target?.live === false, '프로세스가 없으므로 live=false로 표시된다', `live=${target?.live}`)

// S6 first: does an unresumable situation avoid dying silently
const broken = await c2.call('agents.resumeSession', { sessionId: 'no-such-session' }).catch((e) => e)
check(broken instanceof Error, 'S6 없는 세션 재개는 오류로 알린다', broken?.message?.slice(0, 40))

// S5: the actual resume
const res = await c2.call('agents.resumeSession', { sessionId: session.id })
check(res.resumed === true, 'S5 재개 성공', res.reason ?? '')

if (res.resumed) {
  await c2.call('agents.send', { sessionId: session.id, text: 'What was the codeword? Reply with only that word.' })
  await waitFor(c2.events, (e) => e.type === 'turn_complete')
  const answer = textOf(c2.events).trim()
  log('2차 응답:', JSON.stringify(answer.slice(0, 60)))
  check(/PLUM/i.test(answer), 'S5 재개된 세션이 이전 맥락을 기억한다', answer.slice(0, 40))
}

c2.ws.close()
second.host.kill('SIGTERM')
log(failures === 0 ? '전부 통과' : `${failures}건 실패`)
process.exit(failures === 0 ? 0 : 1)
