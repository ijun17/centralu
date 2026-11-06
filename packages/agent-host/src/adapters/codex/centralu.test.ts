import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { OrchestratorTools } from '../contract.js'
import { callOrder, codexCodec, loadRecording, of, recordedFolders, replaySpawner, temporaryFolder } from '../frames/replay.test-helpers.js'
import { centraluInputId } from '../input-receipts.js'
import { drive, type Scenario } from '../frames/scenarios.test-helpers.js'
import { CENTRALU_SCENARIOS } from './centralu-scenarios.test-helpers.js'
import { CodexAdapter } from './index.js'
import { CODEX_RECORDINGS, recordedVersion } from './recorded.test-helpers.js'

/**
 * Codex calling Centralu's own tools, as a real host served them behind the real bridge (`scripts/frames-record-host.mts`, #1498):
 * the lines between the host and the app-server, replayed through the adapter. The tool calls are the app-server's `mcpToolCall`
 * items with their arguments and the host's words as the result; the host and the bridge are not in the recording, so nothing here
 * runs them. A thread's `config` (the bridge's address and credential) and the tools' instructions are not compared: they are
 * the host's, and change with the build.
 */

async function replay(name: string) {
  const dir = recordedVersion()
  const recording = loadRecording(recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const spec = CENTRALU_SCENARIOS.find((s) => s.name === name)!
  const scenario: Scenario = {
    name,
    preset: 'auto',
    async run(d) {
      // The host reads the commands the session offers as it opens it, without waiting for the answer before the first message
      void d.session().listCommands?.()
      for (const text of spec.turns) {
        // As the host sends a person's message: named, so the app-server says it back on the input's item
        d.session().send(text, { id: centraluInputId() })
        await d.waitFor(`the end of the turn "${text.slice(0, 30)}"`, (e) => e.type === 'turn_complete' || e.type === 'error')
      }
    },
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
  return { events, problems: state.problems, left: state.left() }
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

  it('centralu-agent: start_agent is one call that returns the new agent’s answer', async () => {
    const { events } = await replay('centralu-agent')
    expect(calls(events)).toMatchObject([{ tool: 'start_agent' }])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, summary: expect.stringContaining('pong') }])
  })
})
