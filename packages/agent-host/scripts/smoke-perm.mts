/**
 * L3 smoke test: verifies end-to-end that the permission preset behaves as intended on a **real
 * Claude session**.
 *
 * Checks two things (a suspicion raised during dogfooding):
 *   1. Does "auto" really not ask — if it asks, the preset is not being passed through to the process
 *   2. Does "normal" ask — if it does not, the user's global bypass is leaking into the session
 *      (M0 confirmed that "the global setting can be overridden per session"; this checks that it
 *      still holds)
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-perm.mts
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { ensureToolPath } from '../src/env-path.js'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'

ensureToolPath()

async function run(preset: PermissionPreset) {
  const cwd = mkdtempSync(join(tmpdir(), `cc-perm-${preset}-`))
  const events: NormalizedEvent[] = []
  const adapter = new ClaudeAdapter()
  const h = await adapter.createSession(
    { sessionId: `s-${preset}`, cwd, permissionPreset: preset },
    (e) => events.push(e),
  )
  h.send('Create a file named touched.txt containing the word ok. Then reply DONE.')

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (events.some((e) => e.type === 'approval_request')) break
    if (events.some((e) => e.type === 'error')) break
    // Wait a moment after turn_complete for the file write to actually finish
    if (events.some((e) => e.type === 'turn_complete') && existsSync(join(cwd, 'touched.txt'))) break
  }
  const asked = events.filter((e) => e.type === 'approval_request').length
  const errors = events.filter((e) => e.type === 'error') as Extract<NormalizedEvent, { type: 'error' }>[]
  const tools = events.filter((e) => e.type === 'tool_call').length
  const wrote = existsSync(join(cwd, 'touched.txt'))
  await h.dispose().catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  console.log(
    `[${preset}] 승인요청 ${asked} · 도구호출 ${tools} · 파일 ${wrote ? 'O' : 'X'} · 오류 ${errors.length}` +
      (errors.length ? ` (${errors[0]!.error.message.slice(0, 80)})` : ''),
  )
  return { asked, wrote, tools, errors: errors.length }
}

const auto = await run('auto')
const normal = await run('normal')
console.log('\n판정:')
console.log('  auto가 살아서 일했는가:', auto.tools > 0 && auto.errors === 0 ? 'O' : 'X (죽었을 수 있음)')
console.log('  auto가 안 묻는가:', auto.asked === 0 ? 'O' : `X (${auto.asked}건 물음)`)
console.log('  normal은 묻는가:', normal.asked > 0 ? 'O' : 'X (안 물음 — 전역 bypass가 새고 있음)')
process.exit(0)
