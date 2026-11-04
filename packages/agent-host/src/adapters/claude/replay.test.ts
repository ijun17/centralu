import { describe, expect, it } from 'vitest'
import { PermissionPreset, type NormalizedEvent } from '@cc/protocol'
import type { AgentSpawnSpec } from '../contract.js'
import { callOrder, loadRecording, of, recordedFolders, replaySpawner, streamJsonCodec, temporaryFolder } from '../frames/replay.test-helpers.js'
import { drive, scenariosFor } from '../frames/scenarios.test-helpers.js'
import { ClaudeAdapter } from './index.js'
import { CLAUDE_RECORDINGS, recordedVersion } from './recorded.test-helpers.js'

/**
 * The Claude adapter against recordings of the real CLI (#1498): the CLI's stream-json, recorded at its process by
 * `scripts/frames-record.mts` driving this adapter through the scenario, played back to the real SDK and adapter in place of
 * the CLI. A replay checks what the adapter sends the CLI (each line by its kind and what it answers) and what it makes of
 * what the CLI answered, and the tests below read the events it emitted. A scenario's lines were never written by hand.
 */

type Replayed = { events: NormalizedEvent[]; problems: string[]; left: number; spawned: number; started: AgentSpawnSpec[] }

/** The recording of `scenario` played through the adapter; `cwd` is the folder the recording's `<cwd>` stands for */
async function replay(dir: string, name: string): Promise<Replayed> {
  const recording = loadRecording(recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const named = scenariosFor('claude').find((s) => s.name === name)!
  // Driven under the preset it was recorded with
  const preset = PermissionPreset.safeParse(recording.header.preset)
  const scenario = preset.success ? { ...named, preset: preset.data } : named
  const folder = temporaryFolder('claude-replay-')
  const cwd = folder.path
  const { spawn: replayed, state, peers } = replaySpawner(recording, streamJsonCodec(cwd))
  const started: AgentSpawnSpec[] = []
  const spawn = (spec: AgentSpawnSpec) => (started.push(spec), replayed(spec))
  const adapter = new ClaudeAdapter({ platform: 'linux', executable: () => '/usr/local/bin/claude' })
  // A step the adapter never reaches fails with what it sent instead of the recording's next line, not with a timeout
  const events = await drive(adapter, scenario, cwd, `replay-${name}`, 10_000, () => peers.at(-1)?.kill('SIGKILL'), {
    tool: 'claude',
    session: { noSettingFiles: true, model: 'haiku', processSource: { spawn } },
  })
    .catch((e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; the replay found: ${JSON.stringify(state.problems)}, and waits for ${peers.at(-1)?.waitingFor()}`)
    })
    .finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left(), spawned: state.spawned, started }
}

for (const { dir, names: recorded } of recordedFolders(CLAUDE_RECORDINGS)) {
  const names = recorded.filter((n) => scenariosFor('claude').some((s) => s.name === n))
  describe(`replaying ${dir}`, () => {
    for (const name of names) {
      it(`${name}: sends what it sent to the real CLI, and uses every recorded line`, async () => {
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

describe(`what the adapter makes of the CLI's real turns (${recordedVersion()})`, () => {
  const run = (name: string) => replay(recordedVersion(), name)

  it('basic: a plain turn streams its words and ends once; a file written inside the folder under `edits` asks nothing and is marked touched', async () => {
    const { events } = await run('basic')
    expect(ended(events)).toBe(2)
    expect(of(events, 'message_delta')[0]).toMatchObject({ text: 'hello' })
    expect(of(events, 'approval_request')).toEqual([])
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Write'])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
  })

  it('tools: a read and an edit inside the folder are not asked, the command is, once; the edit marks its file', async () => {
    const { events } = await run('tools')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Read', 'Edit', 'Bash'])
    expect(of(events, 'approval_request').map((c) => c.detail)).toMatchObject([{ kind: 'command', command: 'touch tools-done.txt' }])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, true, true])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(ended(events)).toBe(1)
  })

  it('approval: three commands asked and answered allow, deny and always; the same command again is run on the rule, without a card', async () => {
    const { events } = await run('approval')
    expect(of(events, 'approval_request').map((c) => (c.detail.kind === 'command' ? c.detail.command : c.detail.kind))).toEqual(['touch probe-1.txt', 'touch probe-2.txt', 'touch probe-3.txt'])
    expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['allow', 'deny', 'always'])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, false, true, true])
    expect(ended(events)).toBe(4)
  })

  it('interrupt: a Stop in the middle of an answer ends the turn as stopped, not as a failure, and the next turn runs', async () => {
    const { events } = await run('interrupt')
    expect(of(events, 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted')).toHaveLength(1)
    expect(ended(events)).toBe(1)
    expect(said(events)).toMatch(/ok/i)
  })

  it('interrupt-tool: a Stop while a command runs ends the turn as stopped, with no failure, and the next turn runs', async () => {
    const { events } = await run('interrupt-tool')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['PowerShell'])
    expect(of(events, 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted')).toHaveLength(1)
    expect(ended(events)).toBe(1)
  })

  it('interrupt-approval: a Stop while a command waits for the person ends the card and the turn', async () => {
    const { events } = await run('interrupt-approval')
    expect(of(events, 'approval_request')).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
  })

  it('background: the task is live while the turn ends, ends on its own as completed, and the CLI wakes the model with a second turn', async () => {
    const { events } = await run('background')
    const levels = of(events, 'background_tasks')
    expect(levels.find((l) => l.live.length > 0)?.live[0]).toMatchObject({ kind: 'shell', status: 'running' })
    expect(levels.flatMap((l) => l.ended ?? [])).toMatchObject([{ kind: 'shell', status: 'completed' }])
    const firstEnd = events.findIndex((e) => e.type === 'turn_complete')
    expect(events.findIndex((e) => e.type === 'background_tasks' && (e.ended?.length ?? 0) > 0)).toBeGreaterThan(firstEnd)
    expect(ended(events)).toBe(2)
  })

  it('failed: a model that does not exist ends the turn with one error in the CLI’s words, and no completed turn', async () => {
    const { events } = await run('failed')
    expect(of(events, 'error')).toHaveLength(1)
    expect(of(events, 'error')[0]!.error.message).toContain('no-such-model-xyz')
    expect(ended(events)).toBe(0)
  })

  it('big-output: a long answer arrives in order as many deltas and one turn end', async () => {
    const { events } = await run('big-output')
    const lines = said(events).trim().split('\n')
    expect(lines.slice(0, 3)).toEqual(['1', '2', '3'])
    expect(lines.at(-1)).toBe('150')
    expect(lines).toHaveLength(150)
    expect(ended(events)).toBe(1)
  })

  it('compact: the compaction is a marker with the tokens before and after, and the turns on both sides end', async () => {
    const { events } = await run('compact')
    expect(of(events, 'compaction')).toMatchObject([{ failed: false, trigger: 'manual', before: expect.any(Number), after: expect.any(Number) }])
    expect(ended(events)).toBe(3)
  })

  it('resume: the conversation goes on in a new process that knows the first one’s word', async () => {
    const { events, spawned, started } = await run('resume')
    expect(spawned).toBe(2)
    // The second process is told which conversation to go on with (the id the first one said); the first starts a new one
    const flagged = (spec: AgentSpawnSpec, name: string) => spec.args.find((a) => a === name || a.startsWith(`${name}=`)) ?? null
    expect(flagged(started[0]!, '--resume')).toBeNull()
    expect(flagged(started[1]!, '--resume')).toBe('--resume=00000003-0000-4000-8000-000000000002')
    expect(started.map((s) => s.args[s.args.indexOf('--model') + 1])).toEqual(['haiku', 'haiku'])
    expect(said(events)).toContain('pelican')
    expect(of(events, 'agent_version')).toHaveLength(2)
  })

  it('queued: a message sent while a turn runs is answered after it, as its own turn', async () => {
    const { events } = await run('queued')
    expect(ended(events)).toBe(2)
    expect(said(events)).toMatch(/lighthouse[\s\S]*4/i)
  })
})
