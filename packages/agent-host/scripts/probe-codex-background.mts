/**
 * What happens to a Codex child agent when the parent's turn is interrupted, or when its own turn is (#290).
 *
 * Drives `codex app-server` directly in a throwaway folder. One parent turn spawns one child that runs a long `sleep`,
 * does not wait for it, and runs a shorter `sleep` of its own so the parent's turn is still going. Then:
 *
 *   --mode interrupt   once the child's command has started, `turn/interrupt` on the **parent's** turn
 *   --mode stop        once the parent's turn has ended, `turn/interrupt` on the **child's** turn
 *
 * and keeps reading for 20 seconds. Prints the timeline (threads, statuses, turns, collab items) and whether the
 * child's `sleep` process is still alive. The parent thread is deleted at the end.
 *
 * Run with: PROBE_MODEL=gpt-5.6-luna node --import tsx packages/agent-host/scripts/probe-codex-background.mts --mode interrupt
 * (one small parent turn plus one child turn, at effort low)
 *
 * Measured (2026-10-04, codex-cli 0.160.0, gpt-5.6-luna, effort low):
 *   - The child's `thread/status/changed {idle}` then `{active}` and its `turn/started` arrive in the same millisecond
 *     as the parent's `spawnAgent` `item/completed` that names it (`receiverThreadIds`, `agentsStates: pendingInit`).
 *   - interrupt on the parent's turn: the parent's `turn/completed {status: 'interrupted'}` and `{idle}`. The **child
 *     kept running**: still active, it went on reasoning, and its `sleep` was alive 20 s later. It ended only when the
 *     parent thread was deleted (`turn/completed {status: 'interrupted'}` on the child).
 *   - interrupt on the child's own turn (`turn/interrupt {threadId: child, turnId: child's}`): `{idle}` then
 *     `turn/completed {status: 'interrupted'}` on the child, in the same millisecond. The child's shell process was
 *     still alive 20 s later (Codex does not kill a running command on interrupt); it went with the app-server.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from '../src/adapters/codex/client.js'

const mode = process.argv[process.argv.indexOf('--mode') + 1] === 'stop' ? 'stop' : 'interrupt'
const cwd = mkdtempSync(join(tmpdir(), 'cc-codex-bg-'))
const log = join(cwd, '..', `${cwd.split('/').pop()}.frames.jsonl`)
const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
const childAlive = () => /sleep 193/.test(execFileSync('ps', ['-axo', 'pid,command']).toString())

let parent = ''
let parentTurn = ''
const childTurns = new Map<string, string>()
let childCommandStarted = false
let parentDone = false
let acted = false
let stopAt = 0

const act = async (client: CodexClient) => {
  acted = true
  console.log(`${ms()} -- before acting: childAlive=${childAlive()} childTurns=${JSON.stringify([...childTurns])}`)
  if (mode === 'interrupt') {
    console.log(`${ms()} -- turn/interrupt parent ${parentTurn}`)
    console.log(`${ms()} -- reply ${JSON.stringify(await client.request('turn/interrupt', { threadId: parent, turnId: parentTurn }).catch((e: Error) => e.message))}`)
  } else {
    const [thread, turn] = [...childTurns][0] ?? []
    console.log(`${ms()} -- turn/interrupt child ${thread} ${turn}`)
    if (thread && turn) console.log(`${ms()} -- reply ${JSON.stringify(await client.request('turn/interrupt', { threadId: thread, turnId: turn }).catch((e: Error) => e.message))}`)
  }
  stopAt = Date.now() + 20_000
}

const client: CodexClient = new CodexClient(
  {
    onNotification: (n) => {
      appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, n }) + '\n')
      if (n.method.endsWith('/delta') || n.method.includes('Delta')) return
      const p = (n.params ?? {}) as Record<string, unknown>
      const from = String(p.threadId ?? '')
      const who = from === parent ? 'parent' : from ? `child ${from.slice(-6)}` : '-'
      const item = p.item as Record<string, unknown> | undefined
      const turn = p.turn as Record<string, unknown> | undefined
      let tag = ''
      if (n.method === 'thread/status/changed') tag = ` ${JSON.stringify(p.status)}`
      if (turn) tag = ` turn=${String(turn.id)} status=${String(turn.status)}`
      if (item) tag = ` ${String(item.type)}`
      if (item?.type === 'collabAgentToolCall') tag += ` tool=${String(item.tool)} status=${String(item.status)} receivers=${JSON.stringify(item.receiverThreadIds)} states=${JSON.stringify(item.agentsStates)}`
      if (item?.type === 'commandExecution') tag += ` ${JSON.stringify(item.command)} status=${String(item.status)}`
      if (item?.type === 'subAgentActivity') tag += ` kind=${String(item.kind)} agent=${String(item.agentThreadId)}`
      if (item?.type === 'agentMessage' && n.method === 'item/completed') tag += ` ${JSON.stringify(String(item.text ?? '').slice(0, 60))}`
      console.log(`${ms()} ${who.padEnd(13)} ${n.method}${tag}`)
      if (n.method === 'turn/started' && turn) {
        if (from === parent) parentTurn = String(turn.id)
        else childTurns.set(from, String(turn.id))
      }
      if (from && from !== parent && item?.type === 'commandExecution' && n.method === 'item/started') childCommandStarted = true
      if (from === parent && n.method === 'turn/completed') parentDone = true
      if (!acted && (mode === 'interrupt' ? childCommandStarted && !parentDone : parentDone && childTurns.size > 0)) void act(client)
    },
    onServerRequest: (r) => {
      console.log(`${ms()} request ${r.method}`)
      client.respond(r.id, { decision: 'accept' })
    },
    onExit: () => console.log(`${ms()} app-server exited`),
  },
  { cwd },
)

await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
client.notify('initialized')
const started = await client.request<{ thread?: { id?: string } }>('thread/start', {
  cwd,
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  model: process.env.PROBE_MODEL ?? 'gpt-5.6-luna',
  config: { model_reasoning_effort: 'low' },
})
parent = started.thread?.id ?? ''
await client.request('turn/start', {
  threadId: parent,
  effort: 'low',
  input: [
    {
      type: 'text',
      text:
        'Use spawn_agent exactly once to start one child agent with this task: "Run the shell command `sleep 193; echo child-done`, ' +
        'then reply with exactly the word done." Do not wait for the child. Right after spawning it, run the shell command ' +
        '`sleep 25; echo parent-done` yourself, then reply to me with one word. Do nothing else.',
    },
  ],
})
const deadline = Date.now() + 160_000
while (Date.now() < deadline && (stopAt === 0 || Date.now() < stopAt)) await new Promise((r) => setTimeout(r, 250))
console.log(`${ms()} -- after: childAlive=${childAlive()} parentDone=${parentDone}`)
await client.request('thread/delete', { threadId: parent }).catch(() => {})
await client.dispose()
await new Promise((r) => setTimeout(r, 1500))
console.log(`${ms()} -- after dispose: childAlive=${childAlive()}`)
console.log(`frames: ${log}`)
process.exit(0)
