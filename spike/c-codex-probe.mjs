// 검증 C: codex app-server — 전역 approval_policy="never" 상태에서
// thread/start approvalPolicy 오버라이드로 승인 요청이 오는지 + 이벤트 수집
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'

const CWD = new URL('./out/sandbox-codex/', import.meta.url).pathname
mkdirSync(CWD, { recursive: true })

const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
proc.stderr.on('data', d => process.stderr.write('[stderr] ' + d))

const rl = readline.createInterface({ input: proc.stdout })
const events = []
let nextId = 1
const pending = new Map()

function send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n') }
function request(method, params) {
  const id = nextId++
  send({ id, method, params })
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' timeout')) } }, 120000)
  })
}

const approvalsSeen = []
let turnDone = null
const turnDoneP = new Promise(r => { turnDone = r })

rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { console.log('비JSON 라인:', line.slice(0, 120)); return }
  events.push(msg)

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
    return
  }
  // 서버→클라이언트 요청 (승인)
  if (msg.id !== undefined && msg.method) {
    console.log('SERVER_REQUEST:', msg.method, JSON.stringify(msg.params)?.slice(0, 200))
    approvalsSeen.push(msg.method)
    // 승인 응답 (decision 필드 형태는 메서드별 — approved로 시도)
    send({ id: msg.id, result: { decision: 'accept' } })
    return
  }
  // 알림
  if (msg.method) {
    const interesting = /tokenUsage|rateLimits|name\/updated|turn\/(started|completed)|item\/(started|completed)|requestApproval|error|thread\/started/.test(msg.method)
    if (interesting) console.log('NOTIFY:', msg.method, JSON.stringify(msg.params)?.slice(0, 220))
    if (msg.method === 'turn/completed') turnDone()
    if (msg.method === 'error') console.log('ERROR NOTIFY FULL:', JSON.stringify(msg.params))
  }
})

try {
  const init = await request('initialize', {
    clientInfo: { name: 'control-center-spike', title: 'M0 Spike', version: '0.0.1' },
    capabilities: null,
  })
  console.log('initialize OK:', JSON.stringify(init).slice(0, 200))
  send({ method: 'initialized' })

  const thread = await request('thread/start', {
    cwd: CWD,
    approvalPolicy: 'untrusted',          // 전역 "never"를 덮어쓰기 시도
    sandbox: 'workspace-write',
    ephemeral: false,
  })
  console.log('thread/start OK:', JSON.stringify(thread).slice(0, 300))
  const threadId = thread.threadId ?? thread.thread?.id
  console.log('threadId:', threadId)

  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Run this shell command: echo CODEX_SPIKE_OK > probe.txt. Then stop.' }],
  })
  console.log('turn/start 요청 완료, 승인/완료 대기...')

  await Promise.race([turnDoneP, new Promise(r => setTimeout(r, 150000))])
} catch (e) {
  console.log('실패:', e.message)
}

writeFileSync(new URL('./out/codex-events.jsonl', import.meta.url), events.map(e => JSON.stringify(e)).join('\n'))
console.log('\n승인 요청 수신:', approvalsSeen.length, approvalsSeen.join(', '))
console.log('총 이벤트:', events.length, '→ out/codex-events.jsonl')
proc.kill()
process.exit(0)
