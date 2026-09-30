/**
 * L3 smoke test: verifies end-to-end that usage comes out in the same shape from **both real
 * tools**. Covers only subscription limits — does not read credits.
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-usage.mts
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
    const left = w.resetsAt ? `${Math.round((new Date(w.resetsAt).getTime() - Date.now()) / 3600_000)} hours from now` : '?'
    console.log(`  ${w.label.padEnd(14)} ${String(w.percent).padStart(3)}%  resets ${left}${w.scope ? ` · ${w.scope}` : ''}`)
  }
  console.log(`  daily ${s.daily.length} day(s)` + (s.daily.length ? ` (last ${s.daily.at(-1)!.date}: ${s.daily.at(-1)!.tokens.toLocaleString()})` : ''))
  const leaked = JSON.stringify(s).toLowerCase()
  console.log('  no credit info leaked in:', !leaked.includes('credit') ? 'O' : 'X')
}

// claude can only be queried while a live session exists
const cwd = mkdtempSync(join(tmpdir(), 'cc-usage-'))
const ca = new ClaudeAdapter()
const h = await ca.createSession({ sessionId: 'u1', cwd, permissionPreset: 'auto' }, () => {})
await new Promise((r) => setTimeout(r, 7000))
try {
  show('claude', await ca.listUsage())
} catch (e) {
  console.log('\n[claude] failed:', (e as Error).message.slice(0, 120))
}
await h.dispose().catch(() => {})
rmSync(cwd, { recursive: true, force: true })

try {
  show('codex', await new CodexAdapter().listUsage())
} catch (e) {
  console.log('\n[codex] failed:', (e as Error).message.slice(0, 120))
}
process.exit(0)
