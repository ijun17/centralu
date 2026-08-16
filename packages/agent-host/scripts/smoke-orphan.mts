/**
 * L4 스모크: **도구 쪽에서 세션이 사라졌을 때** 우리가 어떻게 처신하는지 본다.
 *
 * 가장 위험한 실패는 오류가 아니라 **조용한 성공**이다 —
 * 이어지는 줄 알고 말을 걸었는데 모델은 앞 대화를 전혀 모르는 상태.
 * 그러면 사용자는 잘못된 전제로 대화를 이어간다.
 *
 * 실행: npx tsx packages/agent-host/scripts/smoke-orphan.mts
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { ensureToolPath } from '../src/env-path.js'
import type { NormalizedEvent } from '@cc/protocol'

ensureToolPath()
const require = createRequire(import.meta.url)
const sdk = require('@anthropic-ai/claude-agent-sdk')
const adapter = new ClaudeAdapter()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cwd = mkdtempSync(join(tmpdir(), 'cc-orphan-'))

// 1) 세션을 만들고 기억할 거리를 준다
const ev1: NormalizedEvent[] = []
const a = await adapter.createSession({ sessionId: 'o1', cwd, permissionPreset: 'auto' }, (e) => ev1.push(e))
a.send('Remember this word: PINEAPPLE. Reply with exactly: OK')
await wait(15_000)
const externalId = a.externalId
await a.dispose().catch(() => {})
console.log('만든 세션:', externalId)

// 2) 도구 쪽에서 지운다 (사용자가 클로드 코드에서 지운 상황)
await sdk.deleteSession(externalId, { dir: cwd }).catch((e: Error) => console.log('삭제 실패:', e.message))
const stillListed = (await sdk.listSessions({ dir: cwd, includeProgrammatic: true })).some(
  (r: { sessionId: string }) => r.sessionId === externalId,
)
console.log('도구 목록에 아직 있나:', stillListed ? 'O' : 'X (지워짐)')

// 3) 우리가 그 세션을 이어가려 하면?
const ev2: NormalizedEvent[] = []
let threw: string | null = null
let handle = null
try {
  handle = await adapter.createSession(
    { sessionId: 'o1', cwd, permissionPreset: 'auto', resumeExternalId: externalId ?? 'gone' },
    (e) => ev2.push(e),
  )
  handle.send('What word did I ask you to remember? Reply with just the word, or NONE.')
  await wait(20_000)
} catch (e) {
  threw = (e as Error).message
}

const reply = ev2
  .filter((e): e is Extract<NormalizedEvent, { type: 'message_delta' }> => e.type === 'message_delta')
  .map((e) => e.text)
  .join('')
const errors = ev2.filter((e): e is Extract<NormalizedEvent, { type: 'error' }> => e.type === 'error')

await handle?.dispose().catch(() => {})
rmSync(cwd, { recursive: true, force: true })

console.log('\n결과:')
console.log('  createSession이 던졌나:', threw ? `O — ${threw.slice(0, 90)}` : 'X (성공했다)')
console.log('  오류 이벤트:', errors.length, errors[0]?.error.message.slice(0, 70) ?? '')
console.log('  모델 응답:', JSON.stringify(reply.trim().slice(0, 80)))
console.log('\n판정:')
const remembered = /PINEAPPLE/i.test(reply)
console.log('  앞 대화를 기억하나:', remembered ? 'O (진짜로 이어짐)' : 'X (맥락 없음)')
console.log(
  '  조용한 실패인가:',
  !threw && errors.length === 0 && !remembered ? 'O ← 위험: 이어진 줄 알지만 아니다' : 'X',
)
process.exit(0)
