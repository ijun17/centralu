/**
 * 실측: 에이전트 바꾸기(claude ↔ codex)가 정말로 되는가.
 *
 * 화면에는 오래전부터 있는 기능인데 "도구마다 세션 형식이 다른데 제대로 들어가긴
 * 하나"라는 의심이 나왔다. 설계상 대화는 안 이어진다(확인 창이 그렇게 말한다).
 * 그러니 물어야 할 것은 하나다: **바꾼 뒤에 그 세션이 실제로 돌아가는가.**
 *
 * 특히 의심스러운 자리: switchTool은 externalId·importedFrom만 지우고
 * model/effort/verbosity/serviceTier는 그대로 둔다. claude의 'sonnet'을 든 채로
 * codex 어댑터에 넘어가면 무슨 일이 일어나는가?
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { CodexAdapter } from '../src/adapters/codex/index.js'
import type { NormalizedEvent } from '@cc/protocol'

const cwd = mkdtempSync(join(tmpdir(), 'switch-probe-'))
console.log('cwd:', cwd)

const log = (tag: string) => (e: NormalizedEvent) => {
  if (e.type === 'message_delta') return // 본문은 시끄럽다
  console.log(`  [${tag}] ${e.type}${'reason' in e && e.reason ? ` (${e.reason})` : ''}`)
  if (e.type === 'error') console.log('      →', JSON.stringify(e).slice(0, 300))
}

/** 실제로 답이 오는가 — 도는 척만 하는지 아닌지는 이걸로만 갈린다 */
async function answers(h: { send: (t: string) => void }, tag: string, sink: NormalizedEvent[]) {
  h.send('Reply with exactly: OK')
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    if (sink.some((e) => e.type === 'turn_complete')) return true
    if (sink.some((e) => e.type === 'error')) return false
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`  [${tag}] 60초 안에 아무 결말도 없음`)
  return false
}

// ── 1. claude로 시작해 모델을 고른다 (사람이 흔히 하는 일)
const claude = new ClaudeAdapter()
const aEvents: NormalizedEvent[] = []
const a = await claude.createSession(
  { sessionId: 'probe', cwd, model: 'sonnet', permissionPreset: 'auto' },
  (e) => { aEvents.push(e); log('claude')(e) },
)
console.log('claude 첫 턴:', (await answers(a, 'claude', aEvents)) ? '답함' : '실패')
const externalId = a.externalId
console.log('claude externalId:', externalId)
await a.dispose()

// ── 2. 고치기 전의 switchTool을 재현한다: 도구만 바꾸고 model은 들고 간다.
//    (이 프로브가 처음 잡은 자리다. 회귀하면 여기서 다시 400이 뜬다)
console.log('\n── [고치기 전 재현] codex로 바꾸며 model="sonnet"을 들고 가면 ──')
const codex = new CodexAdapter()
const bEvents: NormalizedEvent[] = []
try {
  const b = await codex.createSession(
    { sessionId: 'probe', cwd, model: 'sonnet', permissionPreset: 'auto' },
    (e) => { bEvents.push(e); log('codex')(e) },
  )
  console.log('codex 세션 생성: 성공')
  console.log('codex 첫 턴:', (await answers(b, 'codex', bEvents)) ? '답함' : '실패')
  await b.dispose()
} catch (e) {
  console.log('codex 세션 생성: 실패 —', (e as Error).message)
}

// ── 3. 지금 코드가 하는 일: 모델을 놓고 넘어간다 (manager.switchTool)
console.log('\n── [고친 뒤] model을 놓고 codex로 ──')
const cEvents: NormalizedEvent[] = []
try {
  const c = await codex.createSession(
    { sessionId: 'probe2', cwd, permissionPreset: 'auto' },
    (e) => { cEvents.push(e); log('codex-plain')(e) },
  )
  console.log('codex(모델 없음) 첫 턴:', (await answers(c, 'codex-plain', cEvents)) ? '답함' : '실패')
  await c.dispose()
} catch (e) {
  console.log('codex(모델 없음) 생성 실패 —', (e as Error).message)
}

process.exit(0)
