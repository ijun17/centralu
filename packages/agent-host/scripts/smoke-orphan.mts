/**
 * L4 smoke test: checks how we behave when **the session disappears on the tool's side**.
 *
 * The most dangerous failure is not an error but a **silent success** — the user talks to it
 * believing the conversation continued, while the model has no memory of the earlier conversation
 * at all. In that case the user keeps going on a false premise.
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-orphan.mts
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

// 1) Create a session and give it something to remember
const ev1: NormalizedEvent[] = []
const a = await adapter.createSession({ sessionId: 'o1', cwd, permissionPreset: 'auto' }, (e) => ev1.push(e))
a.send('Remember this word: PINEAPPLE. Reply with exactly: OK')
await wait(15_000)
const externalId = a.externalId
await a.dispose().catch(() => {})
console.log('만든 세션:', externalId)

// 2) Delete it on the tool's side (simulating the user deleting it in Claude Code)
await sdk.deleteSession(externalId, { dir: cwd }).catch((e: Error) => console.log('삭제 실패:', e.message))
const stillListed = (await sdk.listSessions({ dir: cwd, includeProgrammatic: true })).some(
  (r: { sessionId: string }) => r.sessionId === externalId,
)
console.log('도구 목록에 아직 있나:', stillListed ? 'O' : 'X (지워짐)')

// 3) What happens if we try to resume that session?
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
