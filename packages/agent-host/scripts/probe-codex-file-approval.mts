/**
 * What a Codex file-change approval request actually carries, and where the change itself is (#169).
 *
 * The adapter read `params.item.changes` from `item/fileChange/requestApproval`, a field the generated
 * type does not have, so the card showed no path and no diff. This drives `codex app-server` directly
 * under the app's `safe` preset (approvalPolicy `untrusted`, sandbox `workspace-write`), asks for one
 * small file edit in a throwaway folder, and records every frame in the order it arrived — so the
 * answer to "is the fileChange item there before the request, and does it carry the diff" is read off
 * the wire rather than off the upstream documentation.
 *
 * The approval is answered `accept`, so the item's completion is recorded too.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-codex-file-approval.mts
 * (one model turn. PROBE_MODEL=<id from model/list> picks a small model; without it Codex's
 * configured default is used, which may be a top-tier one or one the account cannot use. The full
 * frame log is written next to the temp folder and its path printed at the end.)
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openProbe } from './codex-probe-kit.mjs'

let done: () => void = () => {}
const finished = new Promise<void>((r) => (done = r))

const { client, cwd, log } = await openProbe('cc-codex-approval-', {
  onNotification: (n) => {
    if (n.method === 'turn/completed') done()
  },
  onExit: () => done(),
})
writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\n')

const started = await client.request<{ thread?: { id?: string } }>('thread/start', {
  cwd,
  approvalPolicy: 'untrusted',
  sandbox: 'workspace-write',
  ...(process.env.PROBE_MODEL ? { model: process.env.PROBE_MODEL } : {}),
  config: { model_reasoning_summary: 'auto' },
})
const threadId = started.thread?.id
await client.request('turn/start', {
  threadId,
  input: [{ type: 'text', text: 'In notes.txt, change the line "beta" to "gamma". Use your file edit tool, not a shell command. Then stop.' }],
})
const timer = setTimeout(done, 180_000)
await finished
clearTimeout(timer)
await client.dispose()

// The timeline: method, and for items, the item type and id — enough to see the order
for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
  const { ms, dir, frame } = JSON.parse(line) as { ms: number; dir: string; frame: { method: string; params?: Record<string, unknown> } }
  const item = frame.params?.item as { type?: string; id?: string } | undefined
  const tag = item ? ` ${item.type} ${item.id}` : frame.params?.itemId ? ` itemId=${String(frame.params.itemId)}` : ''
  if (frame.method.endsWith('/delta') || frame.method.includes('Delta')) continue
  console.log(`${String(ms).padStart(6)}ms ${dir.padEnd(12)} ${frame.method}${tag}`)
}
console.log(`\nnotes.txt now: ${JSON.stringify(readFileSync(join(cwd, 'notes.txt'), 'utf8'))}`)
console.log(`frames: ${log}`)
process.exit(0)
