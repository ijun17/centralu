/**
 * L3 스모크: 권한 프리셋이 **실제 Claude 세션에서** 의도대로 도는지 관통 검증한다.
 *
 * 확인하는 것 두 가지 (도그푸딩에서 나온 의심):
 *   1. '자동'이 정말 안 묻는가 — 물으면 프리셋이 프로세스에 안 실린 것이다
 *   2. '보통'은 묻는가 — 안 물으면 사용자의 전역 bypass가 세션으로 새고 있는 것이다
 *      (M0에서 "전역 설정을 세션 단위로 덮어쓸 수 있다"를 확인했고, 그게 유지되는지 본다)
 *
 * 실행: npx tsx packages/agent-host/scripts/smoke-perm.mts
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
    // turn_complete 후에도 파일 쓰기가 끝나길 잠깐 기다린다
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
