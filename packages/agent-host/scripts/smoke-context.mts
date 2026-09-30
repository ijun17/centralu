/**
 * L3 smoke test: checks that the context gauge produces sensible values on a real session.
 *
 * Background: back when this was computed from result's modelUsage (a session-wide cumulative
 * figure), it produced "context 533%." The cumulative value grows as turns pile up, so **multiple
 * turns have to run** for this failure mode to show up.
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-context.mts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { ensureToolPath } from '../src/env-path.js'
import type { NormalizedEvent } from '@cc/protocol'

ensureToolPath()
const cwd = mkdtempSync(join(tmpdir(), 'cc-ctx-'))
const events: NormalizedEvent[] = []
const adapter = new ClaudeAdapter()
const h = await adapter.createSession({ sessionId: 'ctx-1', cwd, permissionPreset: 'auto' }, (e) => events.push(e))

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const turns = ['Reply with exactly: A', 'Reply with exactly: B', 'Reply with exactly: C']
for (const [i, text] of turns.entries()) {
  h.send(text)
  const deadline = Date.now() + 60_000
  const before = events.filter((e) => e.type === 'context_update').length
  while (Date.now() < deadline && events.filter((e) => e.type === 'context_update').length === before) {
    await wait(400)
  }
  const last = [...events].reverse().find((e) => e.type === 'context_update') as
    | Extract<NormalizedEvent, { type: 'context_update' }>
    | undefined
  if (!last) {
    console.log(`턴 ${i + 1}: context_update 없음`)
    continue
  }
  const pct = Math.round((last.used / last.window) * 100)
  console.log(`턴 ${i + 1}: ${last.used.toLocaleString()} / ${last.window.toLocaleString()} = ${pct}%`)
}

const updates = events.filter((e) => e.type === 'context_update') as Extract<
  NormalizedEvent,
  { type: 'context_update' }
>[]
const worst = Math.max(...updates.map((u) => (u.used / u.window) * 100))
await h.dispose().catch(() => {})
rmSync(cwd, { recursive: true, force: true })

console.log('\n판정:')
console.log('  보고 횟수:', updates.length)
console.log('  최대 비율이 100% 이하인가:', worst <= 100 ? 'O' : `X (${worst.toFixed(0)}%)`)
console.log('  턴이 쌓여도 폭주하지 않는가:', worst < 50 ? 'O' : '확인 필요')
process.exit(updates.length > 0 && worst <= 100 ? 0 : 1)
