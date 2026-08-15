/**
 * A-5 스모크: 실 Codex 세션으로 host를 관통 검증한다.
 *
 * S9 — 승인 요청 → 허용 → 파일이 실제로 생긴다 (전역 approval_policy="never"를 덮어쓰는지)
 * S10 — host 재시작 후 thread/resume으로 이전 맥락을 기억한다
 * S11 — 좀비 검사: host를 죽이면 codex app-server도 남지 않는다
 *
 * 모델: Codex 기본 모델 (검증에 최상위 모델을 쓰지 않는다 — 문서의 모델 정책)
 * 실행: node packages/agent-host/scripts/smoke-codex.mjs
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
    const t = setTimeout(() => reject(new Error('host 기동 타임아웃')), 20000)
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.ready) { clearTimeout(t); resolve({ host, port: j.port }) }
        } catch { /* 로그 */ }
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
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc 실패'))
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
      setTimeout(() => pending.has(rid) && reject(new Error(`${method} 타임아웃`)), 180000)
    })
  return { ws, call, events, ready }
}

const waitFor = (events, pred, ms = 180000, what = '이벤트') =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const t = setInterval(() => {
      const hit = events.find(pred)
      if (hit) { clearInterval(t); resolve(hit) }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error(`${what} 대기 타임아웃`)) }
    }, 200)
  })

const textOf = (events) => events.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')

// ── 1차: 승인 왕복 (S9) ──────────────────────────────────────────────
const first = await startHost()
const c1 = connect(first.port)
await c1.ready

const detected = await c1.call('agents.detect', {})
const codexInfo = detected.find((d) => d.tool === 'codex')
check(codexInfo?.installed === true, 'Codex 감지', codexInfo?.detail)

const project = await c1.call('projects.add', { path: CWD })
const session = await c1.call('agents.createSession', {
  projectId: project.id, cwd: CWD, tool: 'codex', permissionPreset: 'safe',
  initialPrompt: 'Create a file named codex-ok.txt containing exactly: OK. Remember the codeword MELON. Then stop.',
})
check(!!session.externalId, 'thread id를 생성 즉시 확보', session.externalId ?? '없음')

const approval = await waitFor(c1.events, (e) => e.type === 'approval_request', 180000, '승인 요청')
check(true, 'S9 승인 요청 수신 (전역 never를 세션 단위로 덮어씀)', approval.detail.kind)

await c1.call('agents.respondApproval', {
  sessionId: session.id, requestId: approval.requestId, decision: 'allow',
})
await waitFor(c1.events, (e) => e.type === 'turn_complete', 180000, '턴 완료')
check(existsSync(join(CWD, 'codex-ok.txt')), 'S9 승인 후 파일이 실제로 생성됨')

// FR-18은 첫 프롬프트로 이름을 짓는 것으로 충족된다. Codex의 thread/name/updated는 보너스이며
// 짧은 세션에서는 오지 않는다 (실측). 이름이 실제로 붙었는지를 본다.
const named = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
check(!!named?.name && named.name !== '새 세션', 'FR-18 세션 자동 이름', named?.name?.slice(0, 40))
const titleEvent = c1.events.find((e) => e.type === 'session_title')
log(titleEvent ? `· Codex 제목 이벤트도 수신: ${titleEvent.title}` : '· Codex 제목 이벤트는 오지 않음 (짧은 세션)')
const ctx = c1.events.find((e) => e.type === 'context_update' || e.type === 'usage_update')
check(!!ctx, '토큰/컨텍스트 계기판 이벤트 수신', ctx?.type)

// ── 2차: 재시작 후 재개 (S10) ────────────────────────────────────────
c1.ws.close()
first.host.kill('SIGTERM')
await new Promise((r) => first.host.once('exit', r))

const second = await startHost()
const c2 = connect(second.port)
await c2.ready
const res = await c2.call('agents.resumeSession', { sessionId: session.id })
check(res.resumed === true, 'S10 재개 성공', res.reason ?? '')

if (res.resumed) {
  await c2.call('agents.send', { sessionId: session.id, text: 'What was the codeword? Reply with only that word.' })
  await waitFor(c2.events, (e) => e.type === 'turn_complete', 180000, '재개 후 턴')
  const answer = textOf(c2.events).trim()
  check(/MELON/i.test(answer), 'S10 재개된 세션이 이전 맥락을 기억', answer.slice(0, 40))
}

// ── 3차: 좀비 검사 (S11) ─────────────────────────────────────────────
c2.ws.close()
second.host.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 3000))
let leftover = ''
try {
  leftover = execSync('pgrep -f "codex app-server" || true', { encoding: 'utf8' }).trim()
} catch { /* pgrep 없음 */ }
check(leftover === '', 'S11 host를 죽이면 codex app-server도 남지 않는다', leftover || '없음')

log(failures === 0 ? '전부 통과' : `${failures}건 실패`)
process.exit(failures === 0 ? 0 : 1)
