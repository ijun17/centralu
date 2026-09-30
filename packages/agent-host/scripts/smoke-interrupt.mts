/**
 * L3 smoke test: does Stop actually stop? (dogfooding, 2026-09-07 — "only the tool stops, then it
 * starts back up a few seconds later").
 *
 * The cause was a single argument: `turn/interrupt` was sent with only threadId, and the server
 * rejected it with `missing field turnId` (-32600). The rejection only flowed out as an error
 * event, and the turn ran to completion anyway — the screen looked stopped while the model kept
 * working for another 20 seconds.
 *
 * A unit test checks "what does it send." Here, what is checked is **whether sending it to a real
 * codex actually goes quiet**. Those are different questions, and this bug showed up only in the
 * latter.
 *
 * Run with: pnpm smoke:interrupt   (requires being logged into codex)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureToolPath } from '../src/env-path.js'
import type { NormalizedEvent } from '@cc/protocol'

ensureToolPath()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { CodexAdapter } = await import('../src/adapters/codex/index.js')
const cwd = mkdtempSync(join(tmpdir(), 'cc-interrupt-'))
const events: NormalizedEvent[] = []
const adapter = new CodexAdapter()
const h = await adapter.createSession({ sessionId: 'int-x', cwd, permissionPreset: 'auto' }, (e) => {
  events.push(e)
  if (e.type === 'error') console.log('[codex] error:', e.error.message)
})

h.send('Run bash `sleep 5` three separate times, and say one line each time one finishes.')
// Wait until the tool actually starts running (stopping only makes sense once it has started)
for (let i = 0; i < 40 && !events.some((e) => e.type === 'tool_call'); i++) await wait(500)
const started = events.some((e) => e.type === 'tool_call')
console.log('[codex] tool execution started:', started ? 'O' : 'X (the model did not move — try running it again)')

h.interrupt()
const mark = events.length
// A stray tool_result or usage event from the interrupted turn is expected to trail in. The
// question is **whether the model keeps talking**
await wait(20_000)
const after = events.slice(mark)
const kept = after.filter((e) => e.type === 'message_delta' || e.type === 'tool_call')
console.log(`[codex] 20 seconds after stop: ${after.length} new event(s), of which ${kept.length} show the model still working`)
console.log('[codex] stop:', kept.length === 0 ? 'O (went quiet)' : `X (kept working ${kept.length} more time(s))`)
console.log('[codex] stopped without an error:', after.some((e) => e.type === 'error') ? 'X' : 'O')

await h.dispose().catch(() => {})
rmSync(cwd, { recursive: true, force: true })
process.exit(kept.length === 0 ? 0 : 1)
