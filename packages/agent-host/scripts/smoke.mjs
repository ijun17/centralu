/**
 * G3 smoke test: verifies the host end-to-end against a real Claude session (WS client → RPC → SDK
 * → events).
 * Includes one approval round trip (checks whether the permission override verified in M0 also
 * works in the actual code).
 * Run with: node packages/agent-host/scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'smoke-token'
const cwd = mkdtempSync(join(tmpdir(), 'cc-smoke-'))
const log = (...a) => console.log('[smoke]', ...a)

const host = spawn(
  'node',
  ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--memory'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)

const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('host 기동 타임아웃')), 20000)
  host.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (j.ready) { clearTimeout(t); resolve(j.port) }
      } catch { /* ignore log lines */ }
    }
  })
})
log('host 기동, port =', port)

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const events = []
let nextId = 1
const pending = new Map()

ws.on('message', (raw) => {
  const f = JSON.parse(String(raw))
  if (f.kind === 'res') {
    const p = pending.get(f.id)
    if (p) { pending.delete(f.id); f.ok ? p.res(f.result) : p.rej(new Error(f.error.message)) }
  } else if (f.kind === 'event') {
    events.push(f.event)
    const e = f.event
    if (e.type === 'approval_request') log('승인 요청 수신:', JSON.stringify(e.detail).slice(0, 100))
    if (e.type === 'tool_call') log('도구 호출:', e.summary.title)
    if (e.type === 'turn_complete') log('턴 완료')
  }
})

const rpc = (method, params) => {
  const id = String(nextId++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(method + ' 타임아웃'))), 180000)
  })
}
const waitFor = async (pred, ms, what) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`대기 실패: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const fail = (m) => { console.error('❌', m); cleanup(1) }
const cleanup = (code) => { try { ws.close() } catch {} ; host.kill(); process.exit(code) }

try {
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
  await new Promise((r) => setTimeout(r, 200))

  const project = await rpc('projects.add', { path: cwd })
  log('프로젝트 등록:', project.name)

  const caps = await rpc('agents.capabilities', { tool: 'claude' })
  if (!caps.approvals) fail('capabilities.approvals가 false')

  const session = await rpc('agents.createSession', {
    projectId: project.id, cwd, tool: 'claude', model: 'haiku', permissionPreset: 'normal',
  })
  log('세션 생성:', session.id)

  // Something requiring approval (M0: a safe command like echo gets auto-approved, so a file write
  // is used instead). The path is pinned as absolute to remove any chance of the model picking a
  // different file.
  const target = join(cwd, 'smoke.txt')
  await rpc('agents.send', {
    sessionId: session.id,
    text: `Use the Write tool to create the file ${target} with the exact content: OK. Do not read any other file. Then stop.`,
  })

  await waitFor(() => events.some((e) => e.type === 'approval_request'), 120000, '승인 요청')
  const req = events.find((e) => e.type === 'approval_request')
  log('승인 detail 정규화 확인: kind =', req.detail.kind)
  if (!['file_edit', 'command', 'other'].includes(req.detail.kind)) fail(`알 수 없는 detail kind: ${req.detail.kind}`)
  if (req.detail.kind === 'file_edit' && !req.detail.path) fail('file_edit인데 path가 비어 있음')

  await rpc('agents.respondApproval', { sessionId: session.id, requestId: req.requestId, decision: 'allow' })
  log('승인 전송')

  await waitFor(() => events.some((e) => e.type === 'turn_complete'), 120000, '턴 완료')

  const types = new Set(events.map((e) => e.type))
  log('수집된 이벤트 종류:', [...types].join(', '))
  for (const need of ['approval_request', 'approval_resolved', 'tool_call', 'usage_update', 'turn_complete']) {
    if (!types.has(need)) fail(`필수 이벤트 누락: ${need}`)
  }

  const msgs = await rpc('messages.load', { sessionId: session.id, limit: 100 })
  if (msgs.length === 0) fail('메시지가 영속화되지 않음')
  log('영속화된 메시지:', msgs.length, '건')

  const sessions = await rpc('sessions.list', {})
  log('세션 상태:', sessions[0].state, '| 이름:', sessions[0].name)

  console.log('\n✅ G3 스모크 통과 — 실 SDK 세션으로 승인 왕복까지 완주')
  cleanup(0)
} catch (e) {
  fail(e.message)
}
