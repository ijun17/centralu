/* eslint-disable @typescript-eslint/no-explicit-any -- 스모크는 host의 raw 프레임을 그대로 훑는다 */
/**
 * FR-11 관통 스모크: **실제 Claude 오케스트레이터가 다른 세션에 일을 시키는가.**
 *
 * 계약 테스트는 도구가 붙는 것까지만 본다. 모델이 그 도구를 실제로 부르는지,
 * 그래서 대상 세션이 정말 움직이는지는 여기서만 알 수 있다.
 *
 * 실행: pnpm smoke:orchestrator
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'orc-smoke'
const cwd = mkdtempSync(join(tmpdir(), 'cc-orc-'))
writeFileSync(join(cwd, 'README.md'), '# 대상 프로젝트\n')
const log = (...a: unknown[]) => console.log('[orc]', ...a)

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
      try {
        const j = JSON.parse(line)
        if (j.ready) { clearTimeout(t); res(j.port) }
      } catch { /* 로그 */ }
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
    setTimeout(() => pending.has(id) && (pending.delete(id), j(new Error(m + ' 타임아웃'))), 240000)
  })
}

await new Promise<void>((r) => ws.on('open', () => r()))
ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
await new Promise((r) => setTimeout(r, 300))

// 일을 받을 세션 하나 — 이름으로 찾을 수 있게 분명한 이름을 준다
const project = await rpc('projects.add', { path: cwd })
const worker = await rpc('agents.createSession', {
  projectId: project.id, cwd, tool: 'claude', permissionPreset: 'auto',
})
await rpc('sessions.rename', { sessionId: worker.id, name: 'readme-담당' })
log('대상 세션:', worker.id, '(readme-담당)')

const orc = await rpc('orchestrator.get', {})
log('오케스트레이터:', orc.id, '· projectId =', JSON.stringify(orc.projectId))

// 먼저: 자기가 무엇인지 아는가 (AGENTS.md가 실제로 읽히는지)
{
  const mark = events.length
  await rpc('agents.send', { sessionId: orc.id, text: '너는 무엇이고, 어떤 도구를 갖고 있어? 두 줄로.' })
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (events.slice(mark).some((e) => e.sessionId === orc.id && e.type === 'turn_complete')) {
        clearInterval(t); resolve()
      }
    }, 500)
    setTimeout(() => { clearInterval(t); resolve() }, 120000)
  })
  const who = events.slice(mark).filter((e) => e.sessionId === orc.id && e.type === 'message_delta').map((e) => e.text).join('')
  console.log('\n── 자기소개 ──\n' + who.trim().slice(0, 400) + '\n')
  const knows = /오케스트레이터|Control Center/.test(who) && /list_sessions|send_to_session|손이 없/.test(who)
  console.log(`  자기가 무엇인지 아는가 ${knows ? '✅' : '❌'}\n`)
}

// 오케스트레이터에게 **도구를 쓸 수밖에 없는** 일을 시킨다
const before = events.length
await rpc('agents.send', {
  sessionId: orc.id,
  text: '지금 관리 중인 세션 목록을 확인하고, "readme-담당" 세션에게 "hello라고만 답해줘"라고 전달해줘.',
})

// 오케스트레이터의 턴이 끝날 때까지
await new Promise<void>((resolve) => {
  const t = setInterval(() => {
    if (events.slice(before).some((e) => e.sessionId === orc.id && e.type === 'turn_complete')) {
      clearInterval(t)
      resolve()
    }
  }, 500)
  setTimeout(() => { clearInterval(t); resolve() }, 240000)
})

const mine = events.slice(before)
const toolCalls = mine.filter((e) => e.sessionId === orc.id && e.type === 'tool_call').map((e) => e.summary.tool)
const workerGotWork = mine.some((e) => e.sessionId === worker.id && (e.type === 'state_change' || e.type === 'message_delta'))

const said = mine.filter((e) => e.sessionId === orc.id && e.type === 'message_delta').map((e) => e.text).join('')
log('오케스트레이터가 부른 도구:', toolCalls.join(', ') || '(없음)')
console.log('\n── 오케스트레이터가 한 말 ──\n' + said.slice(0, 1200) + '\n')
for (const e of mine.filter((x) => x.sessionId === orc.id && x.type === 'tool_result')) {
  console.log('── 도구 결과 ──\n' + String(e.summary).slice(0, 600) + '\n')
}
console.log('── 오케스트레이터 이벤트 순서 ──')
console.log(mine.filter((x) => x.sessionId === orc.id).map((x) => x.type).join(' → '))
log('대상 세션이 움직였나:', workerGotWork)

const usedList = toolCalls.some((t) => String(t).includes('list_sessions'))
const usedSend = toolCalls.some((t) => String(t).includes('send_to_session'))
console.log(`\n  list_sessions 호출  ${usedList ? '✅' : '❌'}`)
console.log(`  send_to_session 호출 ${usedSend ? '✅' : '❌'}`)
console.log(`  대상 세션이 실제로 움직임 ${workerGotWork ? '✅' : '❌'}`)

ws.close()
host.kill()
const ok = usedList && usedSend && workerGotWork
console.log(ok ? '\n✅ FR-11 관통 — 오케스트레이터가 다른 세션에 일을 시켰다' : '\n❌ 관통 실패')
process.exit(ok ? 0 : 1)
