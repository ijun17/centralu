/**
 * M1.5 L3 스모크: 실 Claude 세션으로 **재개(FR-10)** 를 관통 검증한다.
 *
 * S5 — host를 껐다 켜도 같은 대화를 이어간다 (이전 맥락을 기억하는지 실제로 물어본다)
 * S6 — 재개 식별자가 깨지면 조용히 죽지 않고 이유를 알린다
 *
 * 검증 모델은 haiku (문서의 모델 정책: 검증에 최상위 모델을 쓰지 않는다).
 * 실행: node packages/agent-host/scripts/smoke-resume.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'smoke-resume'
const DB = join(mkdtempSync(join(tmpdir(), 'cc-resume-')), 'store.db') // 두 번의 host가 공유하는 저장소
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
          /* 로그 라인 */
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

// ── 1차 host: 세션을 만들고 기억할 만한 것을 말한다 ──────────────────
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

// SDK는 세션 id를 첫 init 이벤트에서 알려준다 — 생성 응답 시점에는 아직 없을 수 있다.
// 중요한 것은 '첫 턴이 끝난 뒤에는 반드시 저장돼 있다'는 것 (그래야 재개할 수 있다).
const afterFirstTurn = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
check(!!afterFirstTurn?.externalId, '첫 턴 후 재개 식별자가 저장된다', afterFirstTurn?.externalId ?? '없음')

// ── host 종료 (사용자가 앱을 껐다 켠 상황) ─────────────────────────
c1.ws.close()
first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))
log('host 종료됨 — 프로세스는 사라지고 기록만 남았다')

// ── 2차 host: 같은 저장소로 다시 켜고 재개한다 ─────────────────────
const second = await startHost()
const c2 = connect(second.port)
await c2.ready

const restored = await c2.call('sessions.list', {})
const target = restored.find((s) => s.id === session.id)
check(!!target, '재시작 후에도 세션이 목록에 남는다')
check(target?.live === false, '프로세스가 없으므로 live=false로 표시된다', `live=${target?.live}`)

// S6 먼저: 재개 불가 상황이 조용히 죽지 않는지
const broken = await c2.call('agents.resumeSession', { sessionId: 'no-such-session' }).catch((e) => e)
check(broken instanceof Error, 'S6 없는 세션 재개는 오류로 알린다', broken?.message?.slice(0, 40))

// S5: 진짜 재개
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
