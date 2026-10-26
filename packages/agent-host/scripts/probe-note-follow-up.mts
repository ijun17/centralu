/**
 * Manual, billable Haiku probe for #1604: what does the Claude Code stream say when a note sent into a running turn
 * becomes the next turn? Run: pnpm exec tsx packages/agent-host/scripts/probe-note-follow-up.mts [late|early [delayMs]]
 * Uses the person's Claude authentication; the project folder is temporary. No host is started and no process other
 * than this query is stopped.
 *
 * `late` (default): a note goes in while a tool call runs, near the turn's end. `early`: the turn is a single reply and
 * the note goes in `delayMs` after the task (300 by default; about 2300 reaches the turn's end). Prints, in order, the
 * input writes, the raw messages the adapter reads (type, subtype, the `user_message_uuid`/`user_message_uuids` they name)
 * and the adapter's events. The note goes in the way the hub's does (`sendTracked` under an id it names), and the
 * `state_change` that opens a turn is printed with what `turnStartInputs` says then: for the turn the note started it
 * must be the note's id (#1604).
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '@cc/protocol'
import { ensureToolPath } from '../src/env-path.js'
import { asObj, str } from '../src/json-value.js'

ensureToolPath()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mode = process.argv[2] === 'early' ? 'early' : 'late'
const short = (id: unknown): string => str(id).slice(0, 8)

const { ClaudeAdapter } = await import('../src/adapters/claude/index.js')
const { ClaudeSession } = await import('../src/adapters/claude/session.js')
const t0 = Date.now()
const at = () => `+${String(Date.now() - t0).padStart(6)}ms`

// The adapter reads each message of the CLI's stream here: printed before it is handled, quiet stream events left out
const seen = ClaudeSession.prototype
const original: unknown = Reflect.get(seen, 'onMessage')
if (typeof original !== 'function') throw new Error('the adapter no longer reads the CLI stream in ClaudeSession.onMessage: update this probe')
Reflect.set(seen, 'onMessage', function (this: unknown, q: unknown, raw: unknown) {
  const msg = asObj(raw)
  const named = msg.user_message_uuids ?? msg.user_message_uuid
  if (msg.type !== 'stream_event' || named) {
    const inputs = Array.isArray(named) ? named.map(short) : named ? short(named) : undefined
    console.log(at(), 'RAW', [`type=${str(msg.type)}`, msg.subtype ? `subtype=${str(msg.subtype)}` : '', msg.uuid ? `uuid=${short(msg.uuid)}` : '', inputs ? `inputs=${JSON.stringify(inputs)}` : ''].filter(Boolean).join(' '))
  }
  const result: unknown = Reflect.apply(original, this, [q, raw])
  return result
})

const cwd = mkdtempSync(join(tmpdir(), 'cc-note-follow-up-'))
const events: NormalizedEvent[] = []
const adapter = new ClaudeAdapter()
const handle: { current?: Awaited<ReturnType<typeof adapter.createSession>> } = {}
handle.current = await adapter.createSession({ sessionId: 'note-x', cwd, permissionPreset: 'auto', model: 'haiku' }, (e) => {
  events.push(e)
  if (e.type === 'state_change' || e.type === 'turn_complete' || e.type === 'tool_call' || e.type === 'error') {
    const inputs = e.type === 'state_change' ? handle.current?.turnStartInputs?.() : undefined
    console.log(at(), 'EVT', e.type, e.type === 'state_change' ? e.state : '', e.type === 'error' ? e.error.message : '', inputs ? `startInputs=${JSON.stringify(inputs.map(short))}` : '')
  }
})
const h = handle.current

const task = mode === 'late' ? 'Run the bash command `sleep 8` once, then reply with exactly: FIRST DONE.' : 'Reply with exactly: FIRST DONE.'
const taskId = randomUUID()
const noteId = randomUUID()
console.log(at(), `INPUT task ${short(taskId)}`)
h.send(task, { id: taskId })
if (mode === 'late') for (let i = 0; i < 60 && !events.some((e) => e.type === 'tool_call'); i++) await wait(250)
else await wait(Number(process.argv[3] ?? 300))
console.log(at(), `INPUT note ${short(noteId)}`)
const note = 'Note from the parent: after your reply, also reply with exactly: NOTE SEEN.'
if (h.sendTracked) void h.sendTracked(note, undefined, { id: noteId })
else {
  console.log('no sendTracked yet (before the CLI says hello): the note goes in untracked')
  h.send(note, { id: noteId })
}
await wait(mode === 'late' ? 30_000 : 20_000)
await h.dispose().catch(() => {})
try {
  rmSync(cwd, { recursive: true, force: true })
} catch {
  // The CLI may still hold the folder on Windows
}
process.exit(0)
