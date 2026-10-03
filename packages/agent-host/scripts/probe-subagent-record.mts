/**
 * Does a native subagent's work land in the store, tagged with its launch card (#222)?
 *
 * Runs the real path in-process — the installed CLI, the real adapter, `SessionManager`, a file `Store` — in a
 * throwaway project folder: one turn that launches one subagent which runs one shell command. Then reads what the store
 * holds: the conversation's rows, and the steps under each launch card, through the same call the screen makes.
 *
 * Run with (one small model turn plus one subagent turn):
 *   CC_DATA_DIR=$(mktemp -d) node --import tsx packages/agent-host/scripts/probe-subagent-record.mts claude
 *   CC_DATA_DIR=$(mktemp -d) node --import tsx packages/agent-host/scripts/probe-subagent-record.mts codex
 * `CC_DATA_DIR` is required: the store, attachments and handoff notes go there, never to ~/.centralu.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import { launchesSubagent } from '@cc/protocol'
import type { AgentAdapter } from '../src/adapters/contract.js'
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { CodexAdapter } from '../src/adapters/codex/index.js'
import { Store } from '../src/dev-services/store.js'
import { SessionManager } from '../src/sessions/manager.js'
import { createRpcHandler } from '../src/rpc.js'

const tool = (process.argv[2] ?? 'claude') as ToolName
const data = process.env.CC_DATA_DIR
if (!data) {
  console.error('CC_DATA_DIR must point at a throwaway folder')
  process.exit(2)
}
const cwd = mkdtempSync(join(tmpdir(), `cc-subagent-record-${tool}-`))
const store = new Store(join(data, 'store.db'))
const adapters = new Map<ToolName, AgentAdapter>([
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
])
const events: NormalizedEvent[] = []
const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(data, 'worktrees'))
const rpc = createRpcHandler(mgr, adapters)

const prompt =
  tool === 'claude'
    ? 'Call the Agent tool exactly once (subagent_type "general-purpose", description "probe subagent", run_in_background false) ' +
      'with this prompt: "Run the Bash command `echo sub-probe-ok`, then reply with one short sentence saying what it printed." ' +
      'After it returns, reply to me with one short sentence. Do nothing else.'
    : 'Use spawn_agent exactly once to start one child agent with this task: "Run the shell command `echo sub-probe-ok`, ' +
      'then reply with one short sentence saying what it printed." Then wait for it to finish, and reply to me with one short sentence. Do nothing else.'

const project = (await rpc('projects.add', { path: cwd })) as { id: string }
const session = (await rpc('agents.createSession', {
  projectId: project.id,
  cwd,
  tool,
  permissionPreset: 'auto',
  ...(tool === 'claude' ? { model: 'haiku' } : { model: 'gpt-5.6-luna', effort: 'low' }),
})) as SessionInfo
await rpc('agents.send', { sessionId: session.id, text: prompt })

const ended = () => events.some((e) => e.sessionId === session.id && (e.type === 'turn_complete' || e.type === 'error'))
const t0 = Date.now()
while (!ended() && Date.now() - t0 < 240_000) await new Promise((r) => setTimeout(r, 500))
// A background subagent may still be reporting; give the stream a moment
await new Promise((r) => setTimeout(r, 3_000))
const error = events.find((e) => e.sessionId === session.id && e.type === 'error')
console.log(`turn ${ended() ? 'ended' : 'timed out'} after ${Math.round((Date.now() - t0) / 1000)}s${error ? `: ${JSON.stringify(error).slice(0, 300)}` : ''}`)

const rows = store.loadMessages(session.id, 1000, undefined, { full: true })
console.log(`\nconversation: ${rows.length} rows`)
for (const r of rows) {
  const p = r.payload as { summary?: { tool?: string; title?: string } | string; text?: string; callId?: string }
  const what = typeof p.summary === 'object' ? `${p.summary.tool}: ${p.summary.title}` : (p.text ?? p.summary ?? '')
  console.log(`  ${String(r.seq).padStart(3)} ${r.role.padEnd(9)} ${r.kind.padEnd(11)} ${p.callId ? `[${p.callId}] ` : ''}${String(what).replace(/\n/g, ' ').slice(0, 110)}`)
}

const launches = rows.filter((r) => r.kind === 'tool_call' && launchesSubagent(((r.payload as { summary?: { tool?: string } }).summary?.tool) ?? ''))
for (const launch of launches) {
  const callId = (launch.payload as { callId: string }).callId
  const steps = mgr.loadSubagentMessages(session.id, callId, undefined, 500)
  const full = store.loadSubagentMessages(session.id, callId, { full: true })
  console.log(`\nsteps under ${callId} (as the screen reads them): ${steps.length}`)
  for (const [i, s] of steps.entries()) {
    const p = s.payload as { summary?: { tool?: string; title?: string } | string; text?: string; callId?: string; input?: unknown; output?: unknown }
    const what = typeof p.summary === 'object' ? `${p.summary.tool}: ${p.summary.title}` : (p.text ?? p.summary ?? '')
    const record = full[i]!.payload as { input?: unknown; output?: unknown }
    const kept = [record.input !== undefined ? 'input kept' : '', record.output !== undefined ? 'output kept' : ''].filter(Boolean).join(', ')
    const sent = p.input !== undefined || p.output !== undefined ? ' (!! record leaked to the screen)' : ''
    console.log(`  ${String(s.seq).padStart(3)} ${s.role.padEnd(9)} ${s.kind.padEnd(11)} ${p.callId ? `[${p.callId}] ` : ''}${String(what).replace(/\n/g, ' ').slice(0, 90)}${kept ? ` — ${kept}` : ''}${sent}`)
  }
}

const sent = events.filter((e) => e.type === 'subagent_event')
console.log(`\nbroadcast: ${sent.length} subagent_event, ${events.filter((e) => e.type === 'tool_output_delta').length} tool_output_delta`)
// The parent's own words may quote what its subagent found; the subagent's calls must not be rows of the conversation
const stepCalls = launches.flatMap((l) =>
  store.loadSubagentMessages(session.id, (l.payload as { callId: string }).callId).flatMap((s) => {
    const id = (s.payload as { callId?: string }).callId
    return id ? [id] : []
  }),
)
const inConversation = rows.filter((r) => stepCalls.includes((r.payload as { callId?: string }).callId ?? ''))
console.log(`subagent calls among the conversation's rows: ${inConversation.length}`)
console.log(`search hits that are not conversation rows: ${store.searchMessages('sub-probe-ok').filter((h) => !rows.some((r) => r.seq === h.seq)).length}`)

const externalId = store.listSessions().find((s) => s.id === session.id)?.externalId
await mgr.disposeAll()
// The tool's own copy of this throwaway conversation goes too (Codex: the parent's delete takes its children's rollouts)
if (externalId) await adapters.get(tool)?.deleteExternalConversation?.(externalId, cwd).catch(() => {})
store.close()
console.log(`\ncwd: ${cwd}\nstore: ${join(data, 'store.db')}`)
process.exit(0)
