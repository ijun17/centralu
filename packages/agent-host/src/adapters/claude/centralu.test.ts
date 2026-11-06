import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { AgentSpawnSpec } from '../contract.js'
import { callOrder, loadRecording, of, recordedFolders, replaySpawner, streamJsonCodec, temporaryFolder } from '../frames/replay.test-helpers.js'
import { notingCentraluTools, type Handed } from '../frames/fakes.test-helpers.js'
import { drive, type Scenario } from '../frames/scenarios.test-helpers.js'
import { centraluInputId } from '../input-receipts.js'
import { CLAUDE_CENTRALU_SCENARIOS } from './centralu-scenarios.test-helpers.js'
import { ClaudeAdapter } from './index.js'
import { CLAUDE_RECORDINGS, recordedVersion } from './recorded.test-helpers.js'

/**
 * Claude Code calling Centralu's own tools, as a real host served them (`scripts/frames-record-host.mts claude`, #1498): the CLI's
 * stream-json at its process, replayed through the real SDK and adapter. Centralu's tools are an in-process MCP server of the host,
 * so the CLI's calls to it (`mcp_message`) are in the recording with the host's answers; the replay has no host, so those answers
 * are not compared (`streamJsonCodec`'s `hostAnswers`), while what the CLI then does with them (the call and its result as the
 * screen draws them) is read from the events. The tools the host served are stand-ins that note what the adapter handed them (the
 * arguments the CLI's call carried, through the adapter's MCP server and `runOrchestratorTool`), so a call that never reached its
 * tool, or reached it with other arguments, fails.
 */

async function replay(name: string) {
  const handed: Handed[] = []
  const dir = recordedVersion(name)
  const recording = loadRecording(recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const spec = CLAUDE_CENTRALU_SCENARIOS.find((s) => s.name === name)!
  const scenario: Scenario = {
    name,
    preset: 'auto',
    async run(d) {
      for (const raw of spec.turns) {
        const text = raw.replaceAll('{other}', 'frames-record-other')
        // As the host sends a person's message: named, so the CLI says it back on the input
        d.session().send(text, { id: centraluInputId() })
        await d.waitFor(`the end of the turn "${text.slice(0, 30)}"`, (e) => e.type === 'turn_complete' || e.type === 'error')
      }
    },
  }
  const folder = temporaryFolder('claude-centralu-')
  const cwd = folder.path
  const { spawn: replayed, state, peers } = replaySpawner(recording, streamJsonCodec(cwd, { hostAnswers: true }))
  const started: AgentSpawnSpec[] = []
  const spawn = (s: AgentSpawnSpec) => (started.push(s), replayed(s))
  const events: NormalizedEvent[] = await drive(new ClaudeAdapter({ platform: 'linux', executable: () => '/usr/local/bin/claude' }), scenario, cwd, `replay-${name}`, 10_000, () => peers.at(-1)?.kill('SIGKILL'), {
    tool: 'claude',
    session: { model: 'haiku', processSource: { spawn }, orchestratorTools: notingCentraluTools(handed), toolProfile: 'reader' },
    replay: state,
  }).finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left(), started, handed, waitingFor: peers.at(-1)?.waitingFor() }
}

describe(`Claude Code calling Centralu's tools through a host (${recordedVersion('centralu-agent')})`, () => {
  for (const { name } of CLAUDE_CENTRALU_SCENARIOS) {
    it(`${name}: sends what it sent to the real CLI, and uses every recorded line`, async () => {
      const r = await replay(name)
      expect(r.problems).toEqual([])
      expect(r.left).toBe(0)
      expect(callOrder(r.events)).toEqual([])
    })
  }

  const calls = (events: NormalizedEvent[]) => of(events, 'tool_call').filter((c) => c.summary.centralu)
  const results = (events: NormalizedEvent[]) => of(events, 'tool_result')

  it("centralu-agent: start_agent is one Centralu call, with the job, tool and model the model gave, that returns the child's answer", async () => {
    const { events } = await replay('centralu-agent')
    expect(calls(events)[0]).toMatchObject({ summary: { centralu: { tool: 'start_agent', label: 'Started an agent' } }, input: { task: 'Reply with exactly: pong', tool: 'claude', model: 'haiku' } })
    const answer = results(events).find((r) => r.callId === calls(events)[0]!.callId)
    expect(answer).toMatchObject({ ok: true, summary: expect.stringContaining('pong') })
    expect(of(events, 'approval_request')).toEqual([])
  })

  it('centralu-session: agent_session sends the started agent a message and the call returns its answer; the tool must be looked up first as it is deferred', async () => {
    const { events } = await replay('centralu-session')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(expect.arrayContaining(['mcp__centralu__start_agent', 'ToolSearch', 'mcp__centralu__agent_session']))
    const send = calls(events).find((c) => c.summary.centralu?.tool === 'agent_session')!
    expect(send.input).toMatchObject({ action: 'send', text: 'Reply with exactly: two' })
    expect(results(events).find((r) => r.callId === send.callId)).toMatchObject({ ok: true, summary: expect.stringContaining('two') })
  })

  it('centralu-ask: ask_project into a trusted project returns the other project’s session’s answer, as a success with no card', async () => {
    const { events } = await replay('centralu-ask')
    const ask = calls(events).find((c) => c.summary.centralu?.tool === 'ask_project')!
    expect(ask.input).toMatchObject({ project: 'frames-record-other' })
    expect(results(events).find((r) => r.callId === ask.callId)).toMatchObject({ ok: true, summary: expect.stringContaining('frames-record-other answered') })
    expect(of(events, 'approval_request')).toEqual([])
  })

  it('centralu-failed: a Centralu call the host refuses is a failed result with the host’s words, and the turn still ends normally', async () => {
    const { events } = await replay('centralu-failed')
    const read = calls(events).find((c) => c.summary.centralu?.tool === 'read_session')!
    expect(results(events).find((r) => r.callId === read.callId)).toMatchObject({ ok: false, summary: expect.stringContaining('Not a session in this project') })
    expect(of(events, 'error')).toEqual([])
    expect(of(events, 'turn_complete')).toHaveLength(1)
  })
})

describe('what the adapter hands Centralu’s tools when the CLI calls them', () => {
  const handed = async (name: string) => (await replay(name)).handed

  it('centralu-agent: start_agent reaches its tool with the job, tool and model the model gave', async () => {
    expect(await handed('centralu-agent')).toMatchObject([{ tool: 'start_agent', args: { task: 'Reply with exactly: pong', tool: 'claude', model: 'haiku' } }])
  })

  it('centralu-session: agent_session send reaches its tool with the action, the session and the text', async () => {
    expect(await handed('centralu-session')).toMatchObject([
      { tool: 'start_agent', args: { task: 'Reply with exactly: one' } },
      { tool: 'agent_session', args: { action: 'send', text: 'Reply with exactly: two', sessionId: expect.any(String) } },
    ])
  })

  it('centralu-ask: ask_project reaches its tool with the project and the task', async () => {
    expect(await handed('centralu-ask')).toMatchObject([{ tool: 'ask_project', args: { project: 'frames-record-other', task: 'what is 2+2? Answer in one word.' } }])
  })

  it('centralu-failed: read_session reaches its tool with the id the model gave', async () => {
    expect(await handed('centralu-failed')).toMatchObject([{ tool: 'read_session' }])
  })
})
