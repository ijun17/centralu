import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { OrchestratorTools } from '../contract.js'
import { callOrder, codexCodec, loadRecording, of, recordedFolders, replaySpawner, temporaryFolder } from '../frames/replay.test-helpers.js'
import { centraluInputId } from '../input-receipts.js'
import { drive, type Driver, type Scenario } from '../frames/scenarios.test-helpers.js'
import { CENTRALU_SCENARIOS, type CentraluScenario } from './centralu-scenarios.test-helpers.js'
import { CodexAdapter } from './index.js'
import { CODEX_RECORDINGS, recordedAnswers, recordedFrames, recordedVersion } from './recorded.test-helpers.js'

/**
 * Codex calling Centralu's own tools, as a real host served them behind the real bridge (`scripts/frames-record-host.mts`, #1498):
 * the lines between the host and the app-server, replayed through the adapter. The tool calls are the app-server's `mcpToolCall`
 * items with their arguments and the host's words as the result; the host and the bridge are not in the recording, so nothing here
 * runs them. A thread's `config` (the bridge's address and credential) and the tools' instructions are not compared: they are
 * the host's, and change with the build.
 */

const ended = (e: NormalizedEvent) => e.type === 'turn_complete' || e.type === 'error'
/** The input the host names, as it sends a person's message: the app-server says the name back on the input's item */
const named = () => ({ id: centraluInputId() })

/**
 * What the host does with the session in a recording, in the order the recording shows it: the person's turns; the mail that wakes it
 * (a turn the host starts with the mailbox's words); the nudge it steers into a running turn once the context is large; and the compact
 * command it sends at the end of a turn that asked for one. The host's rules for when are not run here: each happens at the point
 * of the recording where the host did it, so the adapter is what is under test.
 */
async function host(d: Driver, spec: CentraluScenario, hostSent: (method: string) => string[]): Promise<void> {
  // The host reads the commands the session offers as it opens it, without waiting for the answer before the first message
  void d.session().listCommands?.()
  const steers = hostSent('turn/steer')
  const large = (e: NormalizedEvent) => e.type === 'context_update' && e.used > 120_000
  for (const [i, raw] of spec.turns.entries()) {
    const text = raw.replaceAll('{other}', 'frames-record-other')
    d.session().send(text, named())
    // A turn that grows the context past the point the host nudges at: the nudge is steered into it as it runs
    if (spec.name === 'centralu-compact-real') {
      await d.waitFor('the context grown large', large)
      const nudge = steers[i]
      // The app-server took the second and refused the first, which it sent as its turn was ending: "no active turn to steer", so the note starts nothing
      const taken = recordedAnswers(spec.name, 'turn/steer')[i]?.error === undefined
      if (nudge) expect(await d.session().nudge?.(nudge)).toBe(taken)
    }
    await d.waitFor(`the end of the turn "${text.slice(0, 30)}"`, ended)
  }
  if (spec.then?.some((t) => t.type === 'turn_complete')) {
    // The answer arrives by mail and the host starts a turn from it, as the mailbox's channel input
    const [wake] = hostSent('turn/start').slice(spec.turns.length)
    d.session().send(wake!, { origin: { kind: 'channel', server: 'centralu' }, ...named() })
    await d.waitFor('the end of the turn the mail starts', ended)
  }
  if (spec.then?.some((t) => t.type === 'compaction')) {
    // Centralu's own compact, as `SessionEvents.sendCompact` sends it
    d.session().send('/compact', { compact: true })
    await d.waitFor('the compaction', (e) => e.type === 'compaction')
  }
}

async function replay(name: string) {
  const dir = recordedVersion()
  const recording = loadRecording(recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const spec = CENTRALU_SCENARIOS.find((s) => s.name === name)!
  // What the host sent the session on its own in the recording: the turns it starts from mail, the nudges and the compact command
  const hostSent = (method: string) => recordedFrames(name).flatMap((f) => (f.dir === 'out' && f.msg.method === method ? [String(((f.msg.params as { input?: { text?: string }[] }).input ?? [])[0]?.text ?? '')] : []))
  const scenario: Scenario = {
    name,
    preset: 'auto',
    run: (d) => host(d, spec, hostSent),
  }
  const folder = temporaryFolder('codex-centralu-')
  const cwd = folder.path
  const { spawn, state, peers } = replaySpawner(recording, codexCodec(cwd, { ignoreParams: ['config', 'developerInstructions'] }))
  const events: NormalizedEvent[] = await drive(new CodexAdapter(), scenario, cwd, `replay-${name}`, 3_000, () => peers.at(-1)?.kill('SIGKILL'), {
    tool: 'codex',
    session: {
      model: 'gpt-5.6-luna',
      effort: 'low',
      processSource: { spawn },
      orchestratorTools: {} as OrchestratorTools,
      orchestratorBridge: { url: 'ws://127.0.0.1:1', token: 'replay' },
    },
  })
    .catch((e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; the replay found: ${JSON.stringify(state.problems)}, and waits for ${peers.at(-1)?.waitingFor()}`)
    })
    .finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left(), lines: peers.flatMap((p) => p.lines) }
}

describe(`Codex calling Centralu's tools (${recordedVersion()})`, () => {
  for (const { name } of CENTRALU_SCENARIOS) {
    it(`${name}: sends what it sent to the real app-server, and uses every recorded line`, async () => {
      const r = await replay(name)
      expect(r.problems).toEqual([])
      expect(r.left).toBe(0)
      expect(callOrder(r.events)).toEqual([])
    })
  }

  // What the replay does not compare of a thread's start, asserted here: the adapter offers the bridge with the session's credential and runs its tools without a card
  it('the session’s thread is started with Centralu’s bridge: its address and credential, and the tools approved without asking', async () => {
    const { lines } = await replay('centralu-compact')
    const start = lines.find((l) => l.method === 'thread/start')!.params as { config: { mcp_servers: { centralu: { env: Record<string, string>; default_tools_approval_mode: string; tool_timeout_sec: number } } } }
    const bridge = start.config.mcp_servers.centralu
    expect(bridge.env).toMatchObject({ CC_HOST_URL: 'ws://127.0.0.1:1', CC_BRIDGE_TOKEN: 'replay', CC_SESSION_ID: 'replay-centralu-compact' })
    expect(bridge.default_tools_approval_mode).toBe('approve')
    expect(bridge.tool_timeout_sec).toBeGreaterThan(0)
  })

  const calls = (events: NormalizedEvent[]) => of(events, 'tool_call').map((c) => c.summary)

  // What the model chooses to call varies between recordings (it also listed its own children once); these hold for any of them
  it('centralu-read: the project’s sessions are listed and one is read, each call drawn as what it did with the host’s words as its result', async () => {
    const { events } = await replay('centralu-read')
    const summaries = calls(events)
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    expect(summaries.every((c) => c.centralu?.tool === c.tool)).toBe(true)
    expect(summaries.some((c) => c.tool === 'read_session' && c.title === 'Listed sessions')).toBe(true)
    const results = of(events, 'tool_result')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.summary).join('\n')).toContain('marker')
    expect(of(events, 'approval_request')).toEqual([])
  })

  it('centralu-mail: a message to another session is sent and the mailbox looked at, every call succeeding', async () => {
    const { events } = await replay('centralu-mail')
    expect(calls(events).filter((c) => c.tool === 'mail').length).toBeGreaterThanOrEqual(2)
    expect(of(events, 'tool_result').every((r) => r.ok)).toBe(true)
    expect(of(events, 'tool_result').some((r) => /^Sent .* to /.test(r.summary))).toBe(true)
  })

  it('centralu-compact: asked to compact a small conversation, the call succeeds and says it compacts only over 100k tokens; no compaction happens', async () => {
    const { events } = await replay('centralu-compact')
    expect(calls(events)).toMatchObject([{ tool: 'compact_self' }])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, summary: expect.stringContaining('100k') }])
    expect(of(events, 'compaction')).toEqual([])
    expect(of(events, 'turn_complete')).toHaveLength(2)
  })

  // Each test below names the handling it guards. The replays above already fail on any line the adapter sends differently (a nudge's turn id, the compact request, the wake's input); these read what it made of the answers.

  it('centralu-compact-real: guards the compaction marker and the context reading — Centralu’s own compact is manual, the activity ends, and the context falls from over 120k to a few thousand', async () => {
    const { events } = await replay('centralu-compact-real')
    expect(of(events, 'compaction')).toMatchObject([{ failed: false, trigger: 'manual' }])
    expect(of(events, 'activity').map((a) => a.activity)).toEqual(['compacting', null])
    const used = of(events, 'context_update').map((c) => c.used)
    expect(Math.max(...used)).toBeGreaterThan(120_000)
    expect(used.at(-1)).toBeLessThan(10_000)
    // Only the last event of the compaction turn is its own: the turns before it ended as turns of the session
    expect(of(events, 'turn_complete')).toHaveLength(2)
  })

  it('centralu-compact-real: guards the tool-call cards — compact_self is drawn as Centralu’s and succeeds, once per call, however many times the model asked', async () => {
    const { events } = await replay('centralu-compact-real')
    const asked = calls(events).filter((c) => c.tool === 'compact_self')
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(asked.every((c) => c.centralu?.tool === 'compact_self')).toBe(true)
    expect(of(events, 'tool_result').filter((r) => r.summary.includes('compacts this conversation')).length).toBe(asked.length)
  })

  it('centralu-wake: guards the input the mailbox starts a turn with — the turn runs, reads the mail by thread, and ends, as a second turn of the session', async () => {
    const { events } = await replay('centralu-wake')
    expect(of(events, 'turn_complete')).toHaveLength(2)
    const mail = calls(events).filter((c) => c.tool === 'mail')
    expect(mail).toHaveLength(2)
    const results = of(events, 'tool_result')
    expect(results.every((r) => r.ok)).toBe(true)
    // The last result is the mail the other session answered with, read in the turn the mail started
    expect(results.at(-1)!.summary).toContain('Earlier in this chain')
    expect(events.findLastIndex((e) => e.type === 'tool_call')).toBeGreaterThan(events.findIndex((e) => e.type === 'turn_complete'))
    expect(of(events, 'error')).toEqual([])
  })

  it('centralu-agent-session: guards the child-session cards — start, send and wait are three calls of Centralu’s, and the wait returns the answer to both messages', async () => {
    const { events } = await replay('centralu-agent-session')
    expect(calls(events).map((c) => c.tool)).toEqual(['start_agent', 'agent_session', 'agent_session'])
    expect(calls(events).every((c) => c.centralu !== undefined)).toBe(true)
    const results = of(events, 'tool_result')
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.at(-1)!.summary).toContain('one')
    expect(results.at(-1)!.summary).toContain('two')
  })

  it('centralu-ask-project: guards ask_project’s card and its answer — the other project’s session answers and the answer is the result', async () => {
    const { events } = await replay('centralu-ask-project')
    expect(calls(events)).toMatchObject([{ tool: 'ask_project', centralu: { tool: 'ask_project' } }])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, summary: expect.stringContaining('pong') }])
  })

  it('centralu-ask-untrusted: guards what a refusal looks like — the call is a card with a result that says nothing was started and why, and the turn goes on', async () => {
    const { events } = await replay('centralu-ask-untrusted')
    expect(calls(events)).toMatchObject([{ tool: 'ask_project' }])
    const [result] = of(events, 'tool_result')
    expect(result!.summary).toContain('untrusted_project')
    expect(result!.summary).toContain('Nothing was started')
    expect(of(events, 'turn_complete')).toHaveLength(1)
  })

  it('centralu-agent: start_agent is one call that returns the new agent’s answer', async () => {
    const { events } = await replay('centralu-agent')
    expect(calls(events)).toMatchObject([{ tool: 'start_agent' }])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, summary: expect.stringContaining('pong') }])
  })
})
