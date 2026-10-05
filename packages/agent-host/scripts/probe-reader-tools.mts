/**
 * What the reader set (#320) costs a session, and whether a session still reaches for it — measured
 * against the real CLI with haiku.
 *
 * Two questions, one model call per row:
 *   cost   the first request's input tokens (input + cache write + cache read) with no Centralu
 *          server, and with each candidate shape of the set: the four candidate tools in the
 *          orchestrator's words, the same tools re-worded, the reader set all loaded, the set as
 *          shipped (app_guide deferred), and the whole set deferred behind tool search.
 *   use    asked about the project's other sessions, about an earlier conversation, or about how
 *          Centralu works, which tools the session calls — all loaded, as shipped, all deferred.
 *
 * The tools answer from a canned fake (no host, no store, nothing written to a data folder). Settings
 * files are off (`settingSources: []`) and so are the account's claude.ai connectors, so a CLAUDE.md
 * or the user's own MCP servers cannot move the numbers between rows.
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-reader-tools.mts
 * (PROBE_ROWS=cost or PROBE_ROWS=use runs only one half.)
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { OrchestratorTools } from '../src/adapters/contract.js'
import { orchestratorMcp } from '../src/adapters/claude/orchestrator-mcp.js'
import { ORCHESTRATOR_TOOLS, READER_TOOLS, runOrchestratorTool } from '../src/sessions/orchestrator-tools.js'

const claude = execFileSync('which', ['claude']).toString().trim()
const cwd = mkdtempSync(join(tmpdir(), 'cc-reader-'))

const fake = {
  listSessions: async () => [
    { sessionId: 'b7', name: 'db-migration', project: 'shop', state: 'working', tool: 'claude', preview: 'Renaming the orders table' },
    { sessionId: 'c9', name: 'checkout-ui', project: 'shop', state: 'waiting_input', tool: 'codex', preview: 'Done: the button is fixed' },
  ],
  readSession: async () => ({ ok: true, state: 'idle', lines: ['{"role":"user","text":"fix the checkout button"}', '{"role":"assistant","text":"Done: the button is fixed"}'] }),
  recall: async () => ({ hits: [{ sessionId: 'b7', session: 'db-migration', project: 'shop', snippet: 'we chose pg_dump for the backup', seq: 42 }] }),
} as unknown as OrchestratorTools

type Def = { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; load?: boolean }

/** A server from given definitions — for the rows the shipped code does not build */
function server(defs: readonly Def[], alwaysLoad: boolean) {
  return createSdkMcpServer({
    name: 'centralu',
    version: '1',
    alwaysLoad,
    tools: defs.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema.shape,
        async (args: Record<string, unknown>) => {
          const r = await runOrchestratorTool(fake, t.name, args, { sessionId: 'probe', profile: 'reader' })
          return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
        },
        t.load ? { alwaysLoad: true } : undefined,
      ),
    ),
  })
}

const CANDIDATES = ['list_sessions', 'read_session', 'recall', 'app_guide']
/** The four candidates re-worded but kept as four tools — the shape before list_sessions was merged */
const FOUR: Def[] = [
  { name: 'list_sessions', description: "This project's other Centralu sessions: id, state, last line.", schema: z.object({}) },
  { name: 'read_session', description: "Reads one of those sessions' conversation.", schema: z.object({ sessionId: z.string(), around: z.number().optional() }) },
  ...READER_TOOLS.filter((t) => t.name !== 'read_session'),
]

const VARIANTS: Record<string, () => Record<string, unknown>> = {
  none: () => ({}),
  'four, orchestrator text': () => ({ centralu: server(ORCHESTRATOR_TOOLS.filter((t) => CANDIDATES.includes(t.name)), true) }),
  'four, re-worded': () => ({ centralu: server(FOUR, true) }),
  'reader set, all loaded': () => ({ centralu: server(READER_TOOLS, true) }),
  'shipped (app_guide deferred)': () => ({ centralu: orchestratorMcp(fake, 'reader', 'probe') }),
  'reader set, all deferred': () => ({ centralu: server(READER_TOOLS, false) }),
}

async function run(variant: string, prompt: string) {
  const calls: string[] = []
  let first: Record<string, number> | null = null
  let text = ''
  const q = query({
    prompt,
    options: {
      cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: claude,
      settingSources: [],
      permissionMode: 'default',
      mcpServers: VARIANTS[variant]!(),
      maxTurns: 6,
      // The account's claude.ai connectors load even with no settings files, and whether they are up before the first
      // request varies run to run — their deferred names moved the baseline by a hundred tokens
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      canUseTool: async (n: string, i: Record<string, unknown>) =>
        n.startsWith('mcp__centralu__') ? { behavior: 'allow' as const, updatedInput: i } : { behavior: 'deny' as const, message: 'not in this probe' },
    } as never,
  })
  for await (const msg of q) {
    const m = msg as Record<string, unknown>
    const message = m.message as { content?: Record<string, unknown>[]; usage?: Record<string, number> } | undefined
    if (m.type === 'assistant') {
      if (!first && message?.usage) first = message.usage
      for (const b of message?.content ?? []) {
        if (b.type === 'tool_use') calls.push(String(b.name).replace('mcp__centralu__', '') + JSON.stringify(b.input))
        if (b.type === 'text') text += String(b.text)
      }
    }
    if (m.type === 'result') break
  }
  const u = first ?? {}
  const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  return { total, calls, text: text.replace(/\s+/g, ' ').slice(0, 100) }
}

const only = process.env.PROBE_ROWS
if (!only || only === 'cost') {
  console.log('\ncost — first request input tokens (input + cache write + cache read)\n')
  const base = await run('none', 'Reply with the single word OK.')
  console.log(`  ${'none'.padEnd(30)} ${base.total}`)
  for (const v of Object.keys(VARIANTS).filter((v) => v !== 'none')) {
    const r = await run(v, 'Reply with the single word OK.')
    console.log(`  ${v.padEnd(30)} ${r.total}  (+${r.total - base.total})`)
  }
  // Each tool on its own, in each wording — where the tokens go
  for (const [label, defs] of [['orchestrator', ORCHESTRATOR_TOOLS], ['re-worded', FOUR], ['reader set', READER_TOOLS]] as const) {
    for (const t of (defs as readonly Def[]).filter((d) => CANDIDATES.includes(d.name))) {
      const v = `${t.name} (${label})`
      VARIANTS[v] = () => ({ centralu: server([t], true) })
      const r = await run(v, 'Reply with the single word OK.')
      console.log(`  ${v.padEnd(30)} ${r.total}  (+${r.total - base.total})`)
    }
  }
}
if (!only || only === 'use') {
  console.log('\nuse — which tools the session called\n')
  const asks = [
    'What are the other sessions in this project doing right now?',
    'In an earlier conversation we decided how to back up the database. What did we choose?',
    'How do I stop the spinning indicator in Centralu?',
  ]
  // A model's choice varies run to run: PROBE_REPEAT=5 asks each question five times
  const repeat = Number(process.env.PROBE_REPEAT ?? 1)
  const variants = process.env.PROBE_VARIANTS?.split(';') ?? ['reader set, all loaded', 'shipped (app_guide deferred)', 'reader set, all deferred']
  for (const v of variants) {
    for (const a of asks) for (let k = 0; k < repeat; k++) {
      const r = await run(v, a)
      console.log(`  ${v.padEnd(28)} ${a.slice(0, 40).padEnd(42)} calls=[${r.calls.join(' ')}]  "${r.text}"`)
    }
  }
}
process.exit(0)
