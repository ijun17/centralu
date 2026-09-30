/**
 * L3 smoke test: does goal state actually flow through (2026-09-07 — dogfooding: "the badge did
 * not show up").
 *
 * claude: measured conclusion — the headless SDK **has no** /goal (zero active_goal events at the
 *   source; the model only role-played having a goal). Checks that the adapter intercepts it and
 *   refuses honestly.
 * codex: /goal is our own interception → thread/goal/set, get, clear. Checks, using only the
 *   protocol with no token, whether set's updated notification becomes a goal event, and whether
 *   clear comes back as null.
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-goal.mts [claude|codex]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureToolPath } from '../src/env-path.js'
import type { NormalizedEvent } from '@cc/protocol'

ensureToolPath()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const only = process.argv[2]

async function waitFor(events: NormalizedEvent[], pred: (e: NormalizedEvent) => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = events.find(pred)
    if (hit) return hit
    await wait(300)
  }
  return null
}

async function codexSmoke() {
  const { CodexAdapter } = await import('../src/adapters/codex/index.js')
  const cwd = mkdtempSync(join(tmpdir(), 'cc-goal-x-'))
  const events: NormalizedEvent[] = []
  const adapter = new CodexAdapter()
  const h = await adapter.createSession({ sessionId: 'goal-x', cwd, permissionPreset: 'auto' }, (e) => {
    events.push(e)
    if (e.type === 'goal') console.log('[codex] goal 이벤트:', JSON.stringify(e.goal))
    if (e.type === 'message_delta') console.log('[codex] 채팅 줄:', e.text)
    if (e.type === 'error') console.log('[codex] error:', e.error.message)
  })

  h.send('/goal 빌드를 초록으로 유지')
  const set = await waitFor(events, (e) => e.type === 'goal' && e.goal !== null, 15_000)
  console.log('[codex] set 후 goal 이벤트:', set ? 'O' : 'X (안 옴)')

  h.send('/goal')
  await waitFor(events, (e) => e.type === 'message_delta' && /Goal|goal/.test(e.text ?? ''), 10_000)

  const before = events.length
  h.send('/goal clear')
  const cleared = await waitFor(
    events,
    (e, i = events.indexOf(e)) => i >= before && e.type === 'goal' && e.goal === null,
    15_000,
  )
  console.log('[codex] clear 후 goal:null 이벤트:', cleared ? 'O' : 'X (안 옴)')

  await h.dispose().catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  return { set: !!set, cleared: !!cleared }
}

async function claudeSmoke() {
  /*
   * Measured conclusion (2026-09-07): the headless SDK **has no** /goal — a probe at the source
   * found zero active_goal events, zero local_command_output events, and the model only
   * role-played having a goal. So the adapter intercepts it and answers with one honest line.
   * This smoke test records that refusal, and the note that this should be measured again once
   * the SDK exposes a goal API (the wiring to receive active_goal already exists).
   */
  const { ClaudeAdapter } = await import('../src/adapters/claude/index.js')
  const cwd = mkdtempSync(join(tmpdir(), 'cc-goal-c-'))
  const events: NormalizedEvent[] = []
  const adapter = new ClaudeAdapter()
  const h = await adapter.createSession(
    { sessionId: 'goal-c', cwd, permissionPreset: 'auto', model: 'haiku' },
    (e) => {
      events.push(e)
      if (e.type === 'goal') console.log('[claude] goal 이벤트:', JSON.stringify(e.goal))
      if (e.type === 'message_delta') console.log('[claude] 채팅 줄:', (e.text ?? '').slice(0, 120))
    },
  )

  h.send('/goal a file named done.txt exists in this directory')
  const notice = await waitFor(
    events,
    (e) => e.type === 'message_delta' && /interactive Claude CLI/.test(e.text ?? ''),
    5_000,
  )
  console.log('[claude] 정직한 거절 한 줄:', notice ? 'O' : 'X (안 옴)')

  await h.dispose().catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  return { any: !!notice }
}

console.log('=== 골 스모크 ===')
if (only !== 'claude') {
  const x = await codexSmoke()
  console.log(`[codex] 판정: set=${x.set ? 'O' : 'X'} clear=${x.cleared ? 'O' : 'X'}`)
}
if (only !== 'codex') {
  const c = await claudeSmoke()
  console.log(`[claude] 판정: /goal 정직 거절=${c.any ? 'O' : 'X'} (SDK에 골 API 없음 — 실측)`)
}
process.exit(0)
