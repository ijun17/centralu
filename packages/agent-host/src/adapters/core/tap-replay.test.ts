import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { cursorProfile } from '../cursor-agent/index.js'
import { AcpAdapter } from '../acp/adapter.js'
import { loadRecording, replaySpawner } from '../frames/replay.test-helpers.js'
import { drive, SCENARIOS } from '../frames/scenarios.test-helpers.js'

/**
 * ACP records through the process tap, not its connection (docs/plans/session-core.md §6.1): a real recording replayed with
 * recording on yields a recording of the same frames in the same order, and the same events as with it off.
 */
class ReplayAdapter extends AcpAdapter {
  readonly tool = 'replay'
}

const RECORDINGS = fileURLToPath(new URL('../acp/recordings/', import.meta.url))
let dir: string | undefined
const saved = process.env.CC_RECORD_FRAMES
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.CC_RECORD_FRAMES
  else process.env.CC_RECORD_FRAMES = saved
})

async function play(tool: string, name: string, record: boolean) {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), 'cc-tap-replay-'))
  if (record) process.env.CC_RECORD_FRAMES = dir
  else delete process.env.CC_RECORD_FRAMES
  const recording = loadRecording(join(RECORDINGS, tool, `${name}.jsonl`))
  const { spawn, state, peers } = replaySpawner(recording)
  const profile = { ...cursorProfile(), launch: async () => ({ command: 'agent', args: ['acp'] }), installedVersion: async () => String(recording.header.version) }
  const events: NormalizedEvent[] = await drive(new ReplayAdapter(profile, spawn, 60_000), SCENARIOS.find((s) => s.name === name)!, '/work', 'tap-replay', 0, () => peers.at(-1)?.kill('SIGKILL'))
  return { recording, events, problems: state.problems }
}

const shape = (m: Record<string, unknown>) => (typeof m.method === 'string' ? m.method : 'answer')

describe('a recorded replay through the tap', () => {
  const tool = readdirSync(RECORDINGS).find((d) => d.startsWith('cursor-agent-'))!
  const name = readdirSync(join(RECORDINGS, tool))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .find((n) => SCENARIOS.some((s) => s.name === n))!

  it('records the frames the recording holds, in order, and changes no event', async () => {
    const plain = await play(tool, name, false)
    const taped = await play(tool, name, true)
    expect(taped.problems).toEqual([])
    const written = readdirSync(dir!).sort()
    // One file per process, as the recorder has always written them
    expect(written.length).toBeGreaterThan(0)
    const got = written.flatMap((f) =>
      readFileSync(join(dir!, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { dir: string; line?: string }),
    )
    const want = taped.recording.frames
    // A killed peer's exit is reported after the recording ended, so the exits are counted apart
    const frames = <T extends { dir: string }>(all: T[]) => all.filter((e) => e.dir !== 'exit')
    expect(frames(got).map((e) => e.dir)).toEqual(frames(want).map((f) => f.dir))
    expect(got.filter((e) => e.dir === 'exit').length).toBeGreaterThanOrEqual(want.filter((f) => f.dir === 'exit').length)
    expect(got.filter((e) => e.dir !== 'exit').map((e) => shape(JSON.parse(e.line!) as Record<string, unknown>))).toEqual(
      want.filter((f) => f.dir !== 'exit').map((f) => shape(f.msg!)),
    )
    // The per-run random request id prefix is the one thing that may differ
    const stable = (events: NormalizedEvent[]) => JSON.parse(JSON.stringify(events).replace(/acp-req-[0-9a-f]+-/g, 'acp-req-'))
    expect(stable(taped.events)).toEqual(stable(plain.events))
  })
})
