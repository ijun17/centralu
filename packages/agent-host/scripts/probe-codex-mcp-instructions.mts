/**
 * Which of two places Codex shows a session's role text to the model (#525), what resuming with that text does, and
 * whether a thread with no turn can be resumed (#524).
 *
 * #525: Claude gets a seat's role instructions from the in-process MCP server's `instructions`
 * (adapters/claude/orchestrator-mcp.ts). Codex reaches the same tools through a stdio bridge, which could answer
 * `initialize` with the same field, or the text could ride in the thread's `developerInstructions`. This starts a
 * thread with a tiny stdio MCP server whose `initialize` carries a marked `instructions`, and marked developer
 * instructions next to it, asks the model for a phrase from each, and looks for both markers in the thread's rollout
 * (what Codex recorded, read without trusting the model's answer). The thread is then resumed three times on a fresh
 * app-server, the way a restart or a wake does: with other developer instructions (a seat whose role changed, a
 * worktree manager promoted on its wake), with the same ones again, and with none, a turn after each. The rollout
 * says how many developer messages each left, and the turn's usage what the cache kept.
 *
 * #524: before the first turn, a second app-server is asked to resume the thread (and to list it), the way a settings
 * change restarts a session.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-codex-mcp-instructions.mts
 * (PROBE_CALL=1 has the model call the server's tool first, in case Codex shows a server's instructions only once its
 * tools are reached. Four model turns on Codex's configured default model, or PROBE_MODEL=<id>. The thread is deleted
 * at the end.)
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from '../src/adapters/codex/client.js'

const cwd = mkdtempSync(join(tmpdir(), 'cc-codex-instructions-'))
const MCP_MARK = 'MCPMARK-71'
const DEV_A = 'DEVMARK-A42'
const DEV_B = 'DEVMARK-B43'
const server = join(cwd, '..', `${cwd.split('/').pop()}-server.mjs`)
writeFileSync(
  server,
  `let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('data', (c) => {
  buf += c
  for (let nl; (nl = buf.indexOf('\\n')) >= 0; ) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const { id, method, params } = JSON.parse(line)
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' }, instructions: '${MCP_MARK}: the server phrase is kumquat.' } })
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } }] } })
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } })
    else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`,
)
const mcp = { mcp_servers: { probe: { command: process.execPath, args: [server] } } }
const ASK =
  'answer two questions from what you were told before this message: what is the server phrase, and what is the ' +
  'developer phrase? Answer "server: <word or unknown>, developer: <word or unknown>".'

type Usage = { inputTokens?: number; cachedInputTokens?: number }
/** One app-server connection, with the answer and the usage of the turn it runs */
async function connect() {
  let done: () => void = () => {}
  let answer = ''
  let last: Usage = {}
  const client = new CodexClient(
    {
      onNotification: (n) => {
        const p = n.params as { item?: { type?: string; text?: string }; tokenUsage?: { last?: Usage } } | undefined
        if (n.method === 'item/completed' && p?.item?.type === 'agentMessage') answer += p.item.text ?? ''
        if (n.method === 'thread/tokenUsage/updated' && p?.tokenUsage?.last) last = p.tokenUsage.last
        if (n.method === 'turn/completed') done()
      },
      onServerRequest: (r) => client.respond(r.id, { decision: 'decline' }),
      onExit: () => done(),
    },
    { cwd },
  )
  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
  client.notify('initialized')
  const turn = async (threadId: string, text: string) => {
    answer = ''
    const finished = new Promise<void>((r) => (done = r))
    await client.request('turn/start', { threadId, input: [{ type: 'text', text }] })
    const timer = setTimeout(done, 180_000)
    await finished
    clearTimeout(timer)
    return { answer, input: last.inputTokens ?? null, cached: last.cachedInputTokens ?? null }
  }
  return { client, turn }
}

const first = await connect()
const started = await first.client.request<{ thread: { id: string; path?: string } }>('thread/start', {
  cwd,
  approvalPolicy: 'never',
  sandbox: 'read-only',
  ...(process.env.PROBE_MODEL ? { model: process.env.PROBE_MODEL } : {}),
  developerInstructions: `${DEV_A}: the developer phrase is persimmon.`,
  config: mcp,
})
const threadId = started.thread.id

// #524: a second app-server, as a restarted session gets, before any turn
const other = await connect()
const resumeBeforeFirstTurn = await other.client
  .request('thread/resume', { threadId, excludeTurns: true })
  .then(() => 'resumed')
  .catch((e: Error) => `refused: ${e.message}`)
const listedBeforeFirstTurn = await other.client
  .request<{ data?: { id: string }[] }>('thread/list', { cwd, limit: 50 })
  .then((r) => (r.data ?? []).some((t) => t.id === threadId))
  .catch((e: Error) => `list failed: ${e.message}`)
await other.client.dispose()

const turns: Record<string, unknown>[] = []
const pre = process.env.PROBE_CALL ? 'First call the ping tool of the probe MCP server once. Then, without calling anything else, ' : 'Do not call any tool. '
turns.push({ step: 'started with A', ...(await first.turn(threadId, pre + ASK)) })
// The thread's writer is the first app-server: it goes before the thread is resumed elsewhere
await first.client.dispose()

for (const [step, developerInstructions] of [
  ['resumed with B', `${DEV_B}: the developer phrase is quince.`],
  ['resumed with B again', `${DEV_B}: the developer phrase is quince.`],
  ['resumed with none', undefined],
] as const) {
  const c = await connect()
  await c.client.request('thread/resume', { threadId, excludeTurns: true, config: mcp, ...(developerInstructions ? { developerInstructions } : {}) })
  turns.push({ step, ...(await c.turn(threadId, 'Do not call any tool. ' + ASK)) })
  await c.client.dispose()
}

const rollout = (started.thread.path ? readFileSync(started.thread.path, 'utf8') : '').split('\n').filter(Boolean)
const last = await connect()
await last.client.request('thread/delete', { threadId }).catch(() => {})
await last.client.dispose()
/** Every rollout line that holds the mark, as `type/payload type/role@ordinal` */
const where = (mark: string) =>
  rollout
    .filter((l) => l.includes(mark))
    .map((l) => {
      const j = JSON.parse(l) as { type?: string; ordinal?: number; payload?: { type?: string; role?: string } }
      return `${j.type}/${j.payload?.type ?? ''}${j.payload?.role ? `/${j.payload.role}` : ''}@${j.ordinal ?? '?'}`
    })

console.log(
  JSON.stringify(
    {
      threadId,
      beforeFirstTurn: { resume: resumeBeforeFirstTurn, inThreadList: listedBeforeFirstTurn },
      turns,
      rolloutHas: { mcpInstructions: where(MCP_MARK), developerA: where(DEV_A), developerB: where(DEV_B) },
    },
    null,
    1,
  ),
)
process.exit(0)
