/**
 * L3 스모크: 사용량이 **실제 두 도구에서** 같은 모양으로 나오는지 관통 검증한다.
 * 구독 한도만 다룬다 — 크레딧은 읽지 않는다.
 *
 * 실행: npx tsx packages/agent-host/scripts/smoke-usage.mts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { CodexAdapter } from '../src/adapters/codex/index.js'
import { ensureToolPath } from '../src/env-path.js'
import type { UsageSnapshot } from '@cc/protocol'

ensureToolPath()
const show = (name: string, s: UsageSnapshot) => {
  console.log(`\n[${name}] plan=${s.plan ?? '?'}`)
  for (const w of s.windows) {
    const left = w.resetsAt ? `${Math.round((new Date(w.resetsAt).getTime() - Date.now()) / 3600_000)}시간 후` : '?'
    console.log(`  ${w.label.padEnd(14)} ${String(w.percent).padStart(3)}%  초기화 ${left}${w.scope ? ` · ${w.scope}` : ''}`)
  }
  console.log(`  일별 ${s.daily.length}일치` + (s.daily.length ? ` (마지막 ${s.daily.at(-1)!.date}: ${s.daily.at(-1)!.tokens.toLocaleString()})` : ''))
  const leaked = JSON.stringify(s).toLowerCase()
  console.log('  크레딧 정보 안 섞였나:', !leaked.includes('credit') ? 'O' : 'X')
}

// claude는 살아 있는 세션이 있어야 물어볼 수 있다
const cwd = mkdtempSync(join(tmpdir(), 'cc-usage-'))
const ca = new ClaudeAdapter()
const h = await ca.createSession({ sessionId: 'u1', cwd, permissionPreset: 'auto' }, () => {})
await new Promise((r) => setTimeout(r, 7000))
try {
  show('claude', await ca.listUsage())
} catch (e) {
  console.log('\n[claude] 실패:', (e as Error).message.slice(0, 120))
}
await h.dispose().catch(() => {})
rmSync(cwd, { recursive: true, force: true })

try {
  show('codex', await new CodexAdapter().listUsage())
} catch (e) {
  console.log('\n[codex] 실패:', (e as Error).message.slice(0, 120))
}
process.exit(0)
