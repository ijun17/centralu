/**
 * What a Codex child agent sends on the parent's connection (#222).
 *
 * Drives `codex app-server` directly in a throwaway folder: one turn that asks the model to `spawn_agent` one child
 * that runs one shell command and replies, then `wait` for it. Prints the timeline of every notification with the
 * thread it belongs to, the parent's collab items with their `receiverThreadIds`, and writes every frame to a file.
 * The parent thread is deleted at the end (which also removes the child's rollout, measured in #222).
 *
 * Run with: PROBE_MODEL=gpt-5.6-luna node --import tsx packages/agent-host/scripts/probe-codex-subagent.mts
 * (one small model turn plus one child turn, at effort low)
 */
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from '../src/adapters/codex/client.js'

const cwd = mkdtempSync(join(tmpdir(), 'cc-codex-subagent-'))
const log = join(cwd, '..', `${cwd.split('/').pop()}.frames.jsonl`)
const t0 = Date.now()
const record = (dir: string, frame: unknown) => appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, dir, frame }) + '\n')

let parent = ''
let done: () => void = () => {}
const finished = new Promise<void>((r) => (done = r))

const client = new CodexClient(
  {
    onNotification: (n) => {
      record('notification', n)
      const from = (n.params as { threadId?: string } | undefined)?.threadId
      if (n.method === 'turn/completed' && from === parent) done()
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
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  ...(process.env.PROBE_MODEL ? { model: process.env.PROBE_MODEL } : {}),
  config: { model_reasoning_summary: 'auto', model_reasoning_effort: 'low' },
})
parent = started.thread?.id ?? ''
await client.request('turn/start', {
  threadId: parent,
  effort: 'low',
  input: [
    {
      type: 'text',
      text:
        'Use spawn_agent exactly once to start one child agent with this task: "Run the shell command `echo pong-from-child`, ' +
        'then reply with exactly the word pong." Then wait for it to finish, and reply to me with one short sentence. Do nothing else.',
    },
  ],
})
const timer = setTimeout(done, 240_000)
await finished
clearTimeout(timer)

const children = new Set<string>()
for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
  const { ms, dir, frame } = JSON.parse(line) as { ms: number; dir: string; frame: { method: string; params?: Record<string, unknown> } }
  if (frame.method.endsWith('/delta') || frame.method.includes('Delta')) continue
  const from = String(frame.params?.threadId ?? '')
  const who = from === parent ? 'parent' : from ? `child ${from.slice(-6)}` : '-'
  const item = frame.params?.item as Record<string, unknown> | undefined
  let tag = item ? ` ${String(item.type)} ${String(item.id)}` : ''
  if (item?.type === 'collabAgentToolCall') {
    tag += ` tool=${String(item.tool)} receivers=${JSON.stringify(item.receiverThreadIds)} status=${String(item.status)}`
    for (const id of (item.receiverThreadIds as string[] | undefined) ?? []) children.add(id)
  }
  if (item?.type === 'subAgentActivity') tag += ` kind=${String(item.kind)} agentThreadId=${String(item.agentThreadId)}`
  if (item?.type === 'agentMessage') tag += ` text=${JSON.stringify(String(item.text ?? '').slice(0, 60))}`
  if (item?.type === 'commandExecution') tag += ` command=${JSON.stringify(item.command)}`
  console.log(`${String(ms).padStart(6)}ms ${dir.padEnd(12)} ${who.padEnd(13)} ${frame.method}${tag}`)
}
for (const child of children) {
  const read = await client.request<{ thread?: Record<string, unknown> }>('thread/read', { threadId: child, includeTurns: true }).catch((e: Error) => ({ error: e.message }))
  console.log(`\nthread/read ${child}:`, JSON.stringify(read).slice(0, 1500))
}
await client.request('thread/delete', { threadId: parent }).catch(() => {})
await client.dispose()
console.log(`\nframes: ${log}`)
process.exit(0)
