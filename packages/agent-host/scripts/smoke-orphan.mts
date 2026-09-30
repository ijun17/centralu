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
console.log('created session:', externalId)

// 2) Delete it on the tool's side (simulating the user deleting it in Claude Code)
await sdk.deleteSession(externalId, { dir: cwd }).catch((e: Error) => console.log('delete failed:', e.message))
const stillListed = (await sdk.listSessions({ dir: cwd, includeProgrammatic: true })).some(
  (r: { sessionId: string }) => r.sessionId === externalId,
)
console.log('still in the tool listing:', stillListed ? 'O' : 'X (deleted)')

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

console.log('\nResult:')
console.log('  did createSession throw:', threw ? `O — ${threw.slice(0, 90)}` : 'X (it succeeded)')
console.log('  error events:', errors.length, errors[0]?.error.message.slice(0, 70) ?? '')
console.log('  model response:', JSON.stringify(reply.trim().slice(0, 80)))
console.log('\nVerdict:')
const remembered = /PINEAPPLE/i.test(reply)
console.log('  does it remember the earlier conversation:', remembered ? 'O (actually continued)' : 'X (no context)')
console.log(
  '  is this a silent failure:',
  !threw && errors.length === 0 && !remembered ? 'O ← danger: looks continued but is not' : 'X',
)
process.exit(0)
