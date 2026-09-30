/**
 * Measured: does switching tools (claude ↔ codex) actually work?
 *
 * This has been a feature in the UI for a long time, but a suspicion came up: "each tool has a
 * different session format — does it actually go in correctly?" By design the conversation does
 * not continue (the confirmation dialog says so). So there is exactly one thing to ask: **after
 * switching, does that session actually work?**
 *
 * The specific spot under suspicion: switchTool clears only externalId and importedFrom, and
 * leaves model, effort, verbosity, and serviceTier alone. What happens when claude's 'sonnet' is
 * carried over into the codex adapter?
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
  if (e.type === 'message_delta') return // the body content is noisy
  console.log(`  [${tag}] ${e.type}${'reason' in e && e.reason ? ` (${e.reason})` : ''}`)
  if (e.type === 'error') console.log('      →', JSON.stringify(e).slice(0, 300))
}

/** Does an answer actually come back — this is the only thing that separates real work from merely appearing to run */
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

// ── 1. Start with claude and pick a model (a common thing for a person to do)
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

// ── 2. Reproduces switchTool as it was before the fix: only the tool changes, and model is carried
//    over. (This is the spot this probe originally caught. If it regresses, a 400 shows up here again.)
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
