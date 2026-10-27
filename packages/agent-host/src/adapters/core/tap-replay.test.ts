import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { cursorProfile } from '../cursor-agent/index.js'
import { AcpAdapter } from '../acp/adapter.js'
import type { FrameRecorder } from '../frames/recorder.js'
import { loadRecording, replaySpawner } from '../frames/replay.test-helpers.js'
import { drive, SCENARIOS } from '../frames/scenarios.test-helpers.js'

/**
 * ACP records through the process tap, not its connection (docs/plans/session-core.md §6.1): a real recording replayed with
 * recording on yields a recording of the same frames in the same order, and the same events as with it off.
 */
class ReplayAdapter extends AcpAdapter {
  readonly tool = 'replay'
}

type Entry = { dir: 'in' | 'out' | 'exit'; line: string }
let recording = false
const recorded: Entry[] = []
const recorder: FrameRecorder = {
  frame: (dir, line) => recorded.push({ dir, line }),
  exit: () => recorded.push({ dir: 'exit', line: '' }),
}
vi.mock('../frames/recorder.js', () => ({ frameRecorder: () => (recording ? recorder : undefined) }))

const TOOL = 'cursor-agent-2026.10.22'

async function play(name: string, record: boolean) {
  recording = record
  recorded.length = 0
  const rec = loadRecording(`${import.meta.dirname}/../acp/recordings/${TOOL}/${name}.jsonl`)
  const { spawn, state, peers } = replaySpawner(rec)
  const profile = { ...cursorProfile(), launch: async () => ({ command: 'agent', args: ['acp'] }), installedVersion: async () => String(rec.header.version) }
  const events: NormalizedEvent[] = await drive(new ReplayAdapter(profile, spawn, 60_000), SCENARIOS.find((s) => s.name === name)!, '/work', 'tap-replay', 0, () => peers.at(-1)?.kill('SIGKILL'))
  return { rec, events, problems: state.problems }
}

/** A frame's kind, for what differs between runs (the adapter's own request ids): its method, else that it answers */
const kind = (m: unknown): string => (typeof m === 'object' && m !== null && 'method' in m && typeof m.method === 'string' ? m.method : 'answer')
const withoutId = (m: unknown): unknown => (typeof m === 'object' && m !== null ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'id')) : m)
/** The per-run random request id prefix is the one thing that may differ between two runs */
const stable = (events: NormalizedEvent[]): unknown => JSON.parse(JSON.stringify(events).replace(/acp-req-[0-9a-f]+-/g, 'acp-req-'))

describe('a recorded replay through the tap', () => {
  for (const name of ['basic', 'approval', 'interrupt']) {
    it(`${name}: records the frames the recording holds, in order, and changes no event`, async () => {
      const plain = await play(name, false)
      expect(recorded).toEqual([])
      const taped = await play(name, true)
      expect(taped.problems).toEqual([])
      const frames = recorded.filter((e) => e.dir !== 'exit')
      const want = taped.rec.frames.filter((f) => f.dir !== 'exit')
      expect(frames.map((e) => e.dir)).toEqual(want.map((f) => f.dir))
      expect(frames.map((e) => kind(JSON.parse(e.line)))).toEqual(want.map((f) => kind(f.msg)))
      // Every incoming frame is the recorded one once parsed (an answer carries the adapter's own id, which differs per run)
      expect(frames.filter((e) => e.dir === 'in').map((e) => withoutId(JSON.parse(e.line)))).toEqual(want.filter((f) => f.dir === 'in').map((f) => withoutId(f.msg)))
      // A killed peer's exit is reported after the recording ended: at least the recorded ones are there
      expect(recorded.filter((e) => e.dir === 'exit').length).toBeGreaterThanOrEqual(taped.rec.frames.filter((f) => f.dir === 'exit').length)
      expect(stable(taped.events)).toEqual(stable(plain.events))
    })
  }
})
