import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { callOrder, codexCodec, loadRecording, of, recordedFolders, replaySpawner, temporaryFolder } from '../frames/replay.test-helpers.js'
import { CodexAdapter } from './index.js'
import { CODEX_RECORDINGS, recordedFrames, recordedVersion } from './recorded.test-helpers.js'
import { driveAdopted, SWAP_SCENARIOS } from './swap-scenarios.test-helpers.js'

/**
 * A conversation whose app-server lives on while the host changes (a swap under the keeper, #280): the new host's session adopts
 * the process, as recorded from the swap on (`scripts/frames-record.mts codex adopt-running adopt-failed`, #1498). The app-server
 * refuses the second `initialize` on the connection, answers `thread/resume` with the status the thread is in, and goes on
 * with whatever turn it was running.
 */

async function replayAdopted(name: string) {
  const dir = recordedVersion()
  const recording = loadRecording(recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  const scenario = SWAP_SCENARIOS.find((s) => s.name === name)!
  const folder = temporaryFolder('codex-adopt-')
  const cwd = folder.path
  const { spawn, state } = replaySpawner(recording, codexCodec(cwd))
  const process = spawn({ command: 'codex', args: ['app-server'], env: {} })
  const resume = recordedFrames(name).find((f) => f.dir === 'out' && f.msg.method === 'thread/resume')
  const threadId = (resume?.msg.params as { threadId: string }).threadId
  const events: NormalizedEvent[] = await driveAdopted(
    new CodexAdapter(),
    scenario,
    { sessionId: `replay-${name}`, cwd, permissionPreset: scenario.preset ?? 'normal', projectTrusted: true, model: scenario.model ?? 'gpt-5.6-luna', effort: 'low' },
    process,
    threadId,
    0,
  ).finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left() }
}

describe(`adopting an app-server that keeps running (${recordedVersion()})`, () => {
  for (const { name } of SWAP_SCENARIOS) {
    it(`${name}: sends what it sent to the real app-server, and uses every recorded line`, async () => {
      const r = await replayAdopted(name)
      expect(r.problems).toEqual([])
      expect(r.left).toBe(0)
      expect(callOrder(r.events)).toEqual([])
    })
  }

  it('adopt-running: a thread answered as active names its running turn through the turns page, and a Stop reaches that turn', async () => {
    const r = await replayAdopted('adopt-running')
    const asked = recordedFrames('adopt-running').flatMap((f) => (f.dir === 'out' ? [f.msg.method] : []))
    expect(asked.slice(0, 3)).toEqual(['initialize', 'thread/resume', 'thread/turns/list'])
    expect(asked).toContain('turn/interrupt')
    expect(r.events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted')).toHaveLength(1)
    expect(of(r.events, 'error')).toEqual([])
    expect(of(r.events, 'turn_complete')).toHaveLength(1)
  })

  it('adopt-failed: a thread the kept process answers as systemError has no running turn: nothing is asked about one, and the next turn starts and fails once', async () => {
    const r = await replayAdopted('adopt-failed')
    const asked = recordedFrames('adopt-failed').flatMap((f) => (f.dir === 'out' ? [f.msg.method] : []))
    expect(asked).not.toContain('thread/turns/list')
    expect(asked).not.toContain('turn/interrupt')
    expect(of(r.events, 'error')).toHaveLength(1)
    expect(of(r.events, 'error')[0]!.error.data).toMatchObject({ reason: 'model_rejected' })
  })
})
