/**
 * Whether an ACP tool shows the model an MCP server's `initialize` `instructions` (#2479): the door Claude Code takes
 * for Centralu's tool instructions, which codex-cli does not (#525, probe-codex-mcp-instructions.mts). Cursor and
 * OpenCode take no system prompt, so this decides whether the stdio bridge should send its instructions to them.
 *
 * For each tool named (cursor-agent, opencode, antigravity; default the first two) this starts the tool's ACP server the
 * way Centralu does (its profile's `launch`), opens a session with one tiny stdio MCP server whose `initialize` carries a
 * marked phrase, and asks the model for it twice: once from what it was told, once after calling the server's tool (in
 * case a tool shows a server's instructions only once its tools are reached). The server writes down each method it is
 * asked, so "not shown" can be told from "server never started". Permission requests are allowed once.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-acp-mcp-instructions.mts [tool…]
 * with CC_DATA_DIR pointing at a temporary folder. Two model turns per tool on its configured default model.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '@cc/protocol'
import { z } from 'zod'
import type { CreateSessionOpts } from '../src/adapters/contract.js'
import type { AcpProfile } from '../src/adapters/acp/profile.js'
import { AcpConnection } from '../src/adapters/acp/connection.js'
import { startToolProcess } from '../src/adapters/core/tool-process.js'
import { cursorProfile } from '../src/adapters/cursor-agent/index.js'
import { openCodeProfile } from '../src/adapters/opencode/index.js'
import { antigravityProfile } from '../src/adapters/antigravity/index.js'

const Chunk = z.object({ update: z.object({ sessionUpdate: z.string().optional(), content: z.object({ type: z.string().optional(), text: z.string().optional() }).optional() }).optional() })
const Permission = z.object({ options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() })).optional() })
const Created = z.object({ sessionId: z.string() })
const PHRASE = 'kumquat'
const MARK = 'MCPMARK-83'
const PROFILES: Record<string, () => AcpProfile> = { 'cursor-agent': cursorProfile, opencode: openCodeProfile, antigravity: () => antigravityProfile() }

function writeServer(dir: string): { path: string; log: string } {
  const log = join(dir, 'server-methods.log')
  const path = join(dir, 'probe-server.mjs')
  writeFileSync(
    path,
    `import { appendFileSync } from 'node:fs'
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('data', (c) => {
  buf += c
  for (let nl; (nl = buf.indexOf('\\n')) >= 0; ) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const { id, method, params } = JSON.parse(line)
    appendFileSync(${JSON.stringify(log)}, method + '\\n')
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' }, instructions: '${MARK}: the server phrase is ${PHRASE}.' } })
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } }] } })
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } })
    else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  )
  writeFileSync(log, '')
  return { path, log }
}

const ASK =
  'Do not use any tool. From what you were told before this message, what is the server phrase of the "probe" MCP ' +
  'server? Answer "server: <word or unknown>" and nothing else.'
const ASK_AFTER_CALL =
  'Call the "ping" tool of the "probe" MCP server once. Then, from everything you were told, what is the server phrase ' +
  'of that server? Answer "server: <word or unknown>" and nothing else.'

async function probe(tool: string): Promise<void> {
  const make = PROFILES[tool]
  if (!make) throw new Error(`unknown tool ${tool} (one of ${Object.keys(PROFILES).join(', ')})`)
  const profile = make()
  const cwd = mkdtempSync(join(tmpdir(), `cc-acp-instructions-${tool}-`))
  const server = writeServer(cwd)
  const opts: CreateSessionOpts = { sessionId: 'probe', cwd, permissionPreset: 'auto', projectTrusted: true }
  const spec = await profile.launch(opts)
  if (!spec) return void console.log(`${tool}: not installed here`)
  let answer = ''
  const conn = new AcpConnection(
    startToolProcess({ command: spec.command, args: spec.args, env: spec.env ?? process.env, cwd }),
    {
      onNotification: (method, params) => {
        const update = Chunk.safeParse(params).data?.update
        if (method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') answer += update.content.text ?? ''
      },
      onRequest: async (_id, method, params) => {
        if (method !== 'session/request_permission') return null
        const options = Permission.safeParse(params).data?.options ?? []
        const allow = options.find((o) => o.kind === 'allow_once') ?? options[0]
        return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
      },
      onExit: () => {},
    },
    tool,
  )
  try {
    const init = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'centralu-probe', version: '1' } }, 60_000)
    console.log(`${tool}: initialize ${JSON.stringify(init).slice(0, 300)}`)
    const created = Created.parse(await conn.request('session/new', { cwd, mcpServers: [{ name: 'probe', command: process.execPath, args: [server.path], env: [] }] }, 120_000))
    for (const [label, text] of [['told', ASK], ['after a call', ASK_AFTER_CALL]] as const) {
      answer = ''
      await conn.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text }] }, 300_000)
      console.log(`${tool} (${label}): answer ${JSON.stringify(answer.trim())}; phrase ${answer.toLowerCase().includes(PHRASE) ? 'NAMED' : 'not named'}`)
    }
  } catch (err) {
    console.log(`${tool}: failed: ${errorMessage(err)}`)
  } finally {
    const methods = readFileSync(server.log, 'utf8').split('\n').filter(Boolean)
    console.log(`${tool}: the probe server was asked: ${methods.length ? methods.join(', ') : 'nothing (it never started)'}`)
    await conn.dispose()
  }
}

for (const tool of process.argv.slice(2).length ? process.argv.slice(2) : ['cursor-agent', 'opencode']) await probe(tool)
