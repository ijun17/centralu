/* eslint-disable @typescript-eslint/no-explicit-any -- the smoke test reads the host's raw frames directly */
/**
 * End-to-end smoke test: **does a choice reach the screen, and does the answer make it back to the
 * model?** (AskUserQuestion).
 *
 * Displaying it alone with no way to send an answer is only half the feature — that is exactly how
 * the approval card once went dead. So there are two things checked here: does question_request
 * arrive, and once an answer is sent, **does the model know that answer and act on it.**
 *
 * Run with: pnpm smoke:question
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'q-smoke'
const cwd = mkdtempSync(join(tmpdir(), 'cc-q-'))
writeFileSync(join(cwd, 'README.md'), '# 대상\n')

const host = spawn(
  'node',
  ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--memory'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
const port: number = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('host 기동 타임아웃')), 20000)
  host.stdout!.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue
      try { const j = JSON.parse(line); if (j.ready) { clearTimeout(t); res(j.port) } } catch { /* log line */ }
    }
  })
})

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
let n = 1
type Json = Record<string, any>
const pending = new Map<string, { r: (v: Json) => void; j: (e: Error) => void }>()
const events: Json[] = []
ws.on('message', (raw: unknown) => {
  const f = JSON.parse(String(raw))
  if (f.kind === 'res') {
    const p = pending.get(f.id)
    if (p) { pending.delete(f.id); if (f.ok) p.r(f.result); else p.j(new Error(f.error?.message)) }
  } else if (f.kind === 'event') events.push(f.event)
})
const rpc = (m: string, params: unknown): Promise<Json> => {
  const id = String(n++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method: m, params }))
  return new Promise((r, j) => {
    pending.set(id, { r, j })
    setTimeout(() => pending.has(id) && (pending.delete(id), j(new Error(m + ' 타임아웃'))), 180000)
  })
}
const waitFor = (pred: () => boolean, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t = setInterval(() => { if (pred()) { clearInterval(t); resolve(true) } }, 400)
    setTimeout(() => { clearInterval(t); resolve(false) }, ms)
  })

await new Promise<void>((r) => ws.on('open', () => r()))
ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
await new Promise((r) => setTimeout(r, 300))

const project = await rpc('projects.add', { path: cwd })
// Has to be 'normal' for canUseTool to be attached (with auto there is nowhere to intercept it)
const s = await rpc('agents.createSession', { projectId: project.id, cwd, tool: 'claude', permissionPreset: 'normal' })

await rpc('agents.send', {
  sessionId: s.id,
  text: 'AskUserQuestion 도구로 나에게 물어봐: "점심 뭐 먹을까?" 선택지는 "김밥"과 "라면". 도구만 호출해.',
})

const got = await waitFor(() => events.some((e) => e.sessionId === s.id && e.type === 'question_request'), 150000)
const req = events.find((e) => e.sessionId === s.id && e.type === 'question_request')
console.log(`\n  선택지가 화면까지 왔나 ${got ? '✅' : '❌'}`)
if (!got || !req) { ws.close(); host.kill(); process.exit(1) }

const q = req.questions[0]
console.log(`  질문: ${q.question}`)
console.log(`  선택지: ${q.options.map((o: Json) => `${o.label}(${o.description})`).join(' · ')}`)
// Truncation once killed this feature — checks that the description survives whole
const intact = q.options.every((o: Json) => typeof o.description === 'string' && !o.description.endsWith('…'))
console.log(`  선택지 설명이 안 잘렸나 ${intact && q.options.length >= 2 ? '✅' : '❌'}`)

const mark = events.length
await rpc('agents.answerQuestion', {
  sessionId: s.id,
  requestId: req.requestId,
  answers: [{ question: q.question, answers: ['라면'] }],
})

await waitFor(() => events.slice(mark).some((e) => e.sessionId === s.id && e.type === 'turn_complete'), 150000)
const said = events.slice(mark).filter((e) => e.sessionId === s.id && e.type === 'message_delta').map((e) => e.text).join('')
console.log(`\n── 모델이 답을 받고 한 말 ──\n${said.trim().slice(0, 300)}\n`)

const knew = said.includes('라면')
const cleared = events.some((e) => e.sessionId === s.id && e.type === 'question_resolved')
console.log(`  카드가 걷혔나 ${cleared ? '✅' : '❌'}`)
console.log(`  모델이 고른 답을 알고 있나 ${knew ? '✅' : '❌'}`)

// Answering a question that has disappeared must not silently succeed
let toldUs = false
try {
  await rpc('agents.answerQuestion', { sessionId: s.id, requestId: 'q-없는것', answers: [] })
} catch (e) {
  toldUs = String((e as Error).message).includes('사라졌')
}
console.log(`  사라진 질문에 답하면 말해 주나 ${toldUs ? '✅' : '❌'}`)

ws.close()
host.kill()
const ok = got && intact && knew && cleared && toldUs
console.log(ok ? '\n✅ 관통 — 선택지가 그려지고 답이 모델에게 돌아갔다' : '\n❌ 관통 실패')
process.exit(ok ? 0 : 1)
