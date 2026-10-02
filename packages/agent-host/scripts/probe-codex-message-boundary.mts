/**
 * Two Codex agent messages with nothing recorded between them (#212).
 *
 * The store kept "…I'll keep checking.Still running." as one row: the host closes an open text row only at a
 * recorded event, and Codex's polling of a running command (`write_stdin`) is not one — app-server reports it as
 * `item/commandExecution/terminalInteraction`, which is not an item. Found in a real rollout (2026-09-01): five
 * commentary messages, each followed by a `write_stdin` poll, stored as one row.
 *
 * This drives `codex app-server` directly in a throwaway folder and asks for exactly that shape: a command that
 * outlives its first yield, polled while a sentence is said before each poll. It prints the item timeline and
 * every run of agent messages with no recorded item between them, and writes every frame to a file.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-codex-message-boundary.mts
 * (one model turn. PROBE_MODEL=<id from model/list> picks a small model; without it Codex's configured
 * default is used.)
 */
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from '../src/adapters/codex/client.js'

const cwd = mkdtempSync(join(tmpdir(), 'cc-codex-boundary-'))
const log = join(cwd, '..', `${cwd.split('/').pop()}.frames.jsonl`)
const t0 = Date.now()
const record = (dir: string, frame: unknown) => appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, dir, frame }) + '\n')

let done: () => void = () => {}
const finished = new Promise<void>((r) => (done = r))

const client = new CodexClient(
  {
    onNotification: (n) => {
      record('notification', n)
      if (n.method === 'turn/completed') done()
    },
    onServerRequest: (r) => {
      record('request', r)
      client.respond(r.id, { decision: 'accept' })
    },
    onExit: () => done(),
  },
  { cwd },
)

await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
client.notify('initialized')
const started = await client.request<{ thread?: { id?: string } }>('thread/start', {
  cwd,
  // The app's auto preset: nothing is asked, so no approval lands between the messages
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  ...(process.env.PROBE_MODEL ? { model: process.env.PROBE_MODEL } : {}),
  config: { model_reasoning_summary: 'auto' },
})
await client.request('turn/start', {
  threadId: started.thread?.id,
  input: [
    {
      type: 'text',
      text:
        'Start the shell command `sleep 12 && echo finished` with a yield time of 2 seconds, so it keeps running in the background. ' +
        'Then poll it with write_stdin (empty input, 4 second yield) until it exits. ' +
        'Before every poll, write one short sentence to me saying it is still running. Finally say "done".',
    },
  ],
})
const timer = setTimeout(done, 240_000)
await finished
clearTimeout(timer)
await client.dispose()

/** Items the host records (normalize.ts): everything but these is a tool card or a marker */
const UNRECORDED = new Set(['userMessage', 'reasoning', 'agentMessage', 'imageView'])
const runs: string[][] = []
let run: string[] = []
for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
  const { ms, dir, frame } = JSON.parse(line) as { ms: number; dir: string; frame: { method: string; params?: Record<string, unknown> } }
  const item = frame.params?.item as { type?: string; id?: string } | undefined
  /*
   * What closes the host's open row: a tool card or its result (a recorded item starting or completing), an
   * approval, and reasoning text (a switch of kind). A poll, a reasoning item with no summary text and the
   * usage notifications do not.
   */
  const closes =
    dir === 'request' ||
    (frame.method === 'item/reasoning/summaryTextDelta' && !!frame.params?.delta) ||
    ((frame.method === 'item/started' || frame.method === 'item/completed') && !!item?.type && !UNRECORDED.has(item.type))
  if (closes) {
    if (run.length > 1) runs.push(run)
    run = []
  }
  if (frame.method === 'item/started' && item?.type === 'agentMessage') run.push(String(item.id))
  if (frame.method.endsWith('/delta') || frame.method.includes('Delta')) continue
  const tag = item ? ` ${item.type} ${item.id}` : frame.params?.itemId ? ` itemId=${String(frame.params.itemId)}` : ''
  console.log(`${String(ms).padStart(6)}ms ${dir.padEnd(12)} ${frame.method}${tag}`)
}
if (run.length > 1) runs.push(run)
console.log(`\nruns of agent messages with nothing recorded between them (their lengths): ${runs.length ? runs.map((r) => r.length).join(', ') : 'none'}`)
console.log(`frames: ${log}`)
process.exit(0)
