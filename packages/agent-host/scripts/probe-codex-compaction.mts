/**
 * What a Codex compaction leaves on the wire and in the record (#303).
 *
 * codex-cli 0.160.0 stopped sending `thread/compacted`, the notification the adapter made its compaction marker
 * from; the generated binding calls it deprecated in favour of the `contextCompaction` item. This drives
 * `codex app-server` directly in a throwaway git folder and records three things:
 *
 *   1. a manual compaction (`thread/compact/start`, what `/compact` sends) after one short turn,
 *   2. an automatic one, forced cheaply by a per-thread `model_auto_compact_token_limit` (no config.toml change),
 *   3. what `thread/read` and `thread/resume` return afterwards, and the rollout file's compaction lines.
 *
 * Every frame goes to a file next to the folder; a timeline without the deltas is printed.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-codex-compaction.mts
 * (two or three short model turns. PROBE_MODEL picks the model, default gpt-5.6-luna at low effort.)
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from '../src/adapters/codex/client.js'

const model = process.env.PROBE_MODEL ?? 'gpt-5.6-luna'
const cwd = mkdtempSync(join(tmpdir(), 'cc-codex-compact-'))
execFileSync('git', ['init', '-q'], { cwd })
const log = join(cwd, '..', `${cwd.split('/').pop()}.frames.jsonl`)
const t0 = Date.now()
const record = (dir: string, frame: unknown) => appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, dir, frame }) + '\n')

type Frame = { method: string; params?: Record<string, unknown> }
let waiter: { method: string; resolve: () => void } | null = null
const waitFor = (method: string, ms = 180_000) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log(`(timed out waiting for ${method})`)
      resolve()
    }, ms)
    waiter = { method, resolve: () => (clearTimeout(timer), resolve()) }
  })

function open(tag: string): CodexClient {
  const client: CodexClient = new CodexClient(
    {
      onNotification: (n) => {
        record(`${tag} notification`, n)
        if (waiter && n.method === waiter.method) {
          const w = waiter
          waiter = null
          w.resolve()
        }
      },
      onServerRequest: (r) => {
        record(`${tag} request`, r)
        client.respond(r.id, { decision: 'accept' })
      },
      onExit: () => {},
    },
    { cwd },
  )
  return client
}

async function init(client: CodexClient) {
  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
  client.notify('initialized')
}

const say = async (client: CodexClient, threadId: string, text: string) => {
  const done = waitFor('turn/completed')
  await client.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' })
  await done
}

// 1. A manual compaction
const a = open('A')
await init(a)
const started = await a.request<{ thread?: { id?: string; path?: string } }>('thread/start', {
  cwd,
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  model,
  config: { model_reasoning_summary: 'auto' },
})
record('A response', { method: 'thread/start', params: started })
const threadId = String(started.thread?.id)
await say(a, threadId, 'Reply with the single word "ready".')
record('A marker', { method: '--- manual compact ---' })
const compacted = waitFor('turn/completed')
const res = await a.request('thread/compact/start', { threadId })
record('A response', { method: 'thread/compact/start', params: res as Record<string, unknown> })
await compacted
await say(a, threadId, 'Reply with the single word "after".')

// 2. An automatic compaction, on a second thread with a tiny auto-compact limit
const auto = await a.request<{ thread?: { id?: string; path?: string } }>('thread/start', {
  cwd,
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  model,
  config: { model_reasoning_summary: 'auto', model_auto_compact_token_limit: 4000 },
})
const autoId = String(auto.thread?.id)
record('A marker', { method: '--- auto compact thread ---' })
await say(a, autoId, 'Write four short sentences about rivers.')
await say(a, autoId, 'Write four short sentences about mountains.')
await say(a, autoId, 'Reply with the single word "done".')
await a.dispose()

// 3. What the record says afterwards, from a fresh process (as history import and resume would see it)
const b = open('B')
await init(b)
for (const id of [threadId, autoId]) {
  const read = await b.request<{ thread?: { turns?: { items?: unknown[] }[] } }>('thread/read', { threadId: id, includeTurns: true })
  record('B response', { method: 'thread/read', params: read })
  console.log(`\nthread/read ${id}:`)
  for (const [i, t] of (read.thread?.turns ?? []).entries()) {
    console.log(`  turn ${i}: ${(t.items ?? []).map((it) => JSON.stringify(it).slice(0, 120)).join('\n          ')}`)
  }
}
record('B marker', { method: '--- resume ---' })
const resumed = await b.request<{ thread?: { turns?: unknown[] } }>('thread/resume', { threadId, cwd })
record('B response', { method: 'thread/resume', params: resumed })
await new Promise((r) => setTimeout(r, 3000))
await b.dispose()

console.log('\ntimeline (deltas left out):')
for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
  const { ms, dir, frame } = JSON.parse(line) as { ms: number; dir: string; frame: Frame }
  if (/delta|Delta/.test(frame.method) || dir.endsWith('response')) continue
  const item = frame.params?.item as { type?: string; id?: string } | undefined
  const tag = item ? ` ${item.type} ${JSON.stringify(item).slice(0, 160)}` : frame.params ? ` ${JSON.stringify(frame.params).slice(0, 160)}` : ''
  console.log(`${String(ms).padStart(6)}ms ${dir.padEnd(16)} ${frame.method}${tag}`)
}
for (const [label, path] of [['manual', started.thread?.path], ['auto', auto.thread?.path]] as const) {
  if (!path) continue
  console.log(`\nrollout (${label}) ${path} — compaction lines:`)
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/compact/i.test(line)) console.log('  ' + line.slice(0, 300))
  }
}
console.log(`\nframes: ${log}`)
process.exit(0)
