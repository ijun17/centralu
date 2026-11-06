import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { PermissionPreset } from '@cc/protocol'
import type { AgentSpawnSpec } from '../contract.js'
import { callOrder, codexCodec, loadRecording, of, recordedFolders, replaySpawner, temporaryFolder } from '../frames/replay.test-helpers.js'
import { drive, scenariosFor } from '../frames/scenarios.test-helpers.js'
import { CodexAdapter } from './index.js'
import type { CodexClient } from './client.js'
import { CODEX_RECORDINGS, recordedAnswers, recordedNotifications, recordedVersion } from './recorded.test-helpers.js'
import { latestRunningTurn } from './thread-open.js'
import { runningTurnOf } from './turn-reads.js'

/**
 * The Codex adapter against recordings of the real app-server (#1498): its JSON-RPC lines, recorded at the process by
 * `scripts/frames-record.mts` driving this adapter through the scenario, played back in place of the app-server. A replay checks
 * what the adapter sends (each request by its method, each answer to the app-server whole) and what it makes of what came back;
 * the tests below read the events it emitted. A scenario's lines were never written by hand.
 */

type Replayed = { events: NormalizedEvent[]; problems: string[]; left: number; spawned: number; started: AgentSpawnSpec[] }

/** The recording of `name` played through the adapter; the recording's `<cwd>` is the folder the replay runs in */
async function replay(dir: string, name: string): Promise<Replayed> {
  const recording = loadRecording(recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const named = scenariosFor('codex').find((s) => s.name === name)!
  const preset = PermissionPreset.safeParse(recording.header.preset)
  const scenario = preset.success ? { ...named, preset: preset.data } : named
  const folder = temporaryFolder('codex-replay-')
  const cwd = folder.path
  const { spawn: replayed, state, peers } = replaySpawner(recording, codexCodec(cwd))
  const started: AgentSpawnSpec[] = []
  const spawn = (spec: AgentSpawnSpec) => (started.push(spec), replayed(spec))
  const events = await drive(new CodexAdapter(), scenario, cwd, `replay-${name}`, 10_000, () => peers.at(-1)?.kill('SIGKILL'), {
    tool: 'codex',
    session: { model: 'gpt-5.6-luna', effort: 'low', processSource: { spawn } },
    replay: state,
  }).finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left(), spawned: state.spawned, started }
}

for (const { dir, names: recorded } of recordedFolders(CODEX_RECORDINGS)) {
  const names = recorded.filter((n) => scenariosFor('codex').some((s) => s.name === n))
  describe(`replaying ${dir}`, () => {
    for (const name of names) {
      it(`${name}: sends what it sent to the real app-server, and uses every recorded line`, async () => {
        const r = await replay(dir, name)
        expect(r.problems).toEqual([])
        expect(r.left).toBe(0)
        expect(callOrder(r.events)).toEqual([])
      })
    }
  })
}

const said = (events: NormalizedEvent[]) => of(events, 'message_delta').map((e) => e.text).join('')
const ended = (events: NormalizedEvent[]) => of(events, 'turn_complete').length
const stops = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted').length

describe(`what the adapter makes of the app-server’s real turns (${recordedVersion()})`, () => {
  const run = (name: string) => replay(recordedVersion(), name)

  it('basic: a plain turn streams its words and ends once; a file written under `auto` asks nothing and is marked touched', async () => {
    const { events } = await run('basic')
    expect(ended(events)).toBe(2)
    expect(of(events, 'message_delta')[0]).toMatchObject({ text: 'hello' })
    expect(of(events, 'approval_request')).toEqual([])
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Edit'])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
  })

  it('approval: three commands asked and answered allow, deny and always; the same command again is run on the rule, without a card', async () => {
    const { events } = await run('approval')
    expect(of(events, 'approval_request').map((c) => (c.detail.kind === 'command' ? c.detail.command : c.detail.kind))).toEqual([
      "/bin/zsh -lc 'touch probe-1.txt'",
      "/bin/zsh -lc 'touch probe-2.txt'",
      "/bin/zsh -lc 'touch probe-3.txt .'",
    ])
    expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['allow', 'deny', 'always'])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, false, true, true])
    expect(ended(events)).toBe(4)
  })

  it('interrupt: a Stop in the middle of an answer ends the turn as stopped, not as a failure, and the next turn runs', async () => {
    const { events } = await run('interrupt')
    expect(of(events, 'error')).toEqual([])
    expect(stops(events)).toBe(1)
    expect(ended(events)).toBe(1)
    expect(said(events)).toMatch(/ok/i)
  })

  it('interrupt-approval: a Stop while a command waits for the person ends the card and the turn', async () => {
    const { events } = await run('interrupt-approval')
    expect(of(events, 'approval_request')).toHaveLength(1)
    expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['deny'])
    expect(of(events, 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
  })

  it('queued: a message sent while a turn runs joins that turn (the app-server steers it in), and both are answered by the one turn that ends', async () => {
    const { events } = await run('queued')
    expect(ended(events)).toBe(1)
    expect(said(events)).toMatch(/\b(?:four|4)\b/i)
    expect(of(events, 'error')).toEqual([])
  })

  it('failed: a model that does not exist ends the turn with one error naming it, no completed turn, and a notice that its metadata is missing', async () => {
    const { events } = await run('failed')
    expect(of(events, 'error')).toHaveLength(1)
    expect(of(events, 'error')[0]!.error).toMatchObject({ retryable: false, data: { reason: 'model_rejected', model: 'no-such-model-xyz' } })
    expect(ended(events)).toBe(0)
    expect(of(events, 'notice')[0]).toMatchObject({ level: 'warning', from: 'Codex' })
  })

  it('big-output: a long answer arrives in order as many deltas and one turn end', async () => {
    const { events } = await run('big-output')
    const lines = said(events).trim().split('\n')
    expect(lines.slice(0, 3)).toEqual(['1', '2', '3'])
    expect(lines.at(-1)).toBe('150')
    expect(lines).toHaveLength(150)
    expect(ended(events)).toBe(1)
  })

  it('long-command: a command that takes twelve seconds is one call with its output and one result', async () => {
    const { events } = await run('long-command')
    expect(of(events, 'tool_call').map((c) => c.summary.title)).toEqual(["/bin/zsh -lc 'sleep 12 && echo long-done'"])
    expect(of(events, 'tool_output_delta').map((d) => d.text).join('')).toBe('long-done\n')
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, output: 'long-done\n' }])
    expect(ended(events)).toBe(1)
  })

  it('command-failed: a command that exits with an error is one call that ends not ok with its own words, and the turn goes on to say so', async () => {
    const { events } = await run('command-failed')
    expect(of(events, 'tool_call').map((c) => c.summary.title)).toEqual(["/bin/zsh -lc 'ls /no-such-folder-xyz'"])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: false, summary: expect.stringContaining('No such file or directory') }])
    expect(of(events, 'error')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('long-output: a command with a long output is one result that keeps the output whole and shows its start', async () => {
    const { events } = await run('long-output')
    const [result] = of(events, 'tool_result')
    expect(result!.output?.split('\n')).toHaveLength(3001)
    expect(result!.output!.length).toBeGreaterThan(result!.summary.length)
    expect(result!.output!.startsWith(result!.summary)).toBe(true)
    expect(ended(events)).toBe(1)
  })

  it('mcp-call: a call to a tool of the person’s MCP server is one call named by server and tool, with its answer', async () => {
    const { events } = await run('mcp-call')
    expect(of(events, 'tool_call')).toMatchObject([{ summary: { tool: 'ping', title: 'probe: ping' } }])
    expect(of(events, 'tool_result')).toMatchObject([{ ok: true, summary: 'pong' }])
    expect(of(events, 'approval_request')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('files: a file created and then deleted with the patch tool are two calls, each marking its file', async () => {
    const { events } = await run('files')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Edit', 'Edit'])
    expect(of(events, 'approval_request')).toEqual([])
    expect(of(events, 'files_touched')).toHaveLength(2)
    expect(ended(events)).toBe(1)
  })

  it('compact: the compaction is a marker, shown as an activity while it runs, and the turns on both sides end', async () => {
    const { events } = await run('compact')
    expect(of(events, 'compaction')).toMatchObject([{ failed: false, trigger: 'manual' }])
    const activities = of(events, 'activity').map((a) => a.activity)
    expect(activities).toEqual(['compacting', null])
    expect(ended(events)).toBe(3)
  })

  it('die: the app-server killed in the middle of a turn is one retryable crash, not a completed turn', async () => {
    const { events } = await run('die')
    expect(of(events, 'error')).toMatchObject([{ error: { code: 'adapter_crashed', retryable: true, message: expect.stringContaining('codex app-server exited') } }])
    expect(ended(events)).toBe(0)
  })

  it('resume: the conversation goes on in a new process that knows the first one’s word', async () => {
    const { events, spawned } = await run('resume')
    expect(spawned).toBe(2)
    expect(said(events).toLowerCase()).toContain('pelican')
    expect(ended(events)).toBe(2)
    expect(of(events, 'error')).toEqual([])
  })

  it('resume-interrupted: a thread whose last turn was stopped opens again as idle and takes the next turn', async () => {
    const { events, spawned } = await run('resume-interrupted')
    expect(spawned).toBe(2)
    expect(stops(events)).toBe(1)
    expect(of(events, 'error')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('resume-failed: a thread whose last turn failed opens again without a second error', async () => {
    const { events, spawned } = await run('resume-failed')
    expect(spawned).toBe(2)
    expect(of(events, 'error')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'goal', goal: null })
  })
})

/**
 * What the app-server answers `thread/resume` with, after a turn that completed, one the person stopped and one that failed
 * (measured on the recordings, codex-cli 0.160.0): the thread is `idle` in all three, with no turns (`excludeTurns`). The status
 * `systemError` is not in the answer: it is said once, live, as the failed turn ends, in the process that ran it.
 */
describe('a thread opened again after a turn that ended in each way', () => {
  const statusOf = (answer: { result?: Record<string, unknown> }) => dig(answer.result, 'thread.status.type')
  const dig = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v)

  for (const [name, how] of [['resume', 'completed'], ['resume-interrupted', 'stopped'], ['resume-failed', 'failed']] as const) {
    it(`${name}: after a ${how} turn it is idle, names no running turn, and asks no one about it`, async () => {
      const [answer] = recordedAnswers(name, 'thread/resume')
      expect(statusOf(answer!)).toBe('idle')
      expect(runningTurnOf(answer!.result)).toBeNull()
      const request = vi.fn()
      expect(await latestRunningTurn({ request } as unknown as CodexClient, 'record-session', 'thread', answer!.result!)).toBeNull()
      expect(request).not.toHaveBeenCalled()
    })
  }

  it('the status a failed turn goes through is active, then systemError, then the turn’s end as failed; the thread is idle again only on opening', () => {
    const statuses = recordedNotifications('failed', 'thread/status/changed').map((n) => dig(n.params, 'status.type'))
    expect(statuses).toEqual(['active', 'systemError'])
    expect(recordedNotifications('failed', 'turn/completed').map((n) => dig(n.params, 'turn.status'))).toEqual(['failed'])
  })
})
