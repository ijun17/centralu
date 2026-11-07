import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { AgentSpawnSpec } from '../contract.js'
import { codexCodec, loadRecording, recordedFolders, ReplayPeer, replaySpawner, temporaryFolder, type Recording } from '../frames/replay.test-helpers.js'
import { CODEX_RECORDINGS, CODEX_REPLAY_SESSION, recordedVersion } from './recorded.test-helpers.js'

/**
 * A Codex app-server that exits on its own, on the path every session takes: the host starts the process itself (no
 * keeper, no `processSource`). A process that goes while nothing is in flight is asleep, not crashed (#1397: a Codex
 * session keeps its app-server while idle, #568, so a shutdown or a kill lands on idle sessions too); an exit with a turn
 * open, before `turn/start` is answered, during a compact, or before the thread is open is a crash, and the crash says
 * what the process printed last (#428).
 *
 * The app-server is the recording's: each case plays the frames of a real run up to the point the test names, and the
 * process then ends. Only the exit itself is the test's, and the stderr line, which no recording holds.
 */
const wire = vi.hoisted(() => ({ spawn: null as null | ((spec: AgentSpawnSpec) => unknown) }))

// The direct path: `startToolProcess` without a source starts its process with `spawn`, here the replay's
vi.mock('../core/tool-process.js', async (original) => {
  const real = await original<typeof import('../core/tool-process.js')>()
  return { ...real, startToolProcess: (spec: never, how: object = {}) => real.startToolProcess(spec, { ...how, spawn: wire.spawn as never }) }
})

const { CodexAdapter } = await import('./index.js')

type Frame = Recording['frames'][number]
const file = (scenario: string) => recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === recordedVersion())!.file(scenario)
const isOut = (method: string) => (f: Frame) => f.dir === 'out' && f.msg?.method === method
/** The recorded frames through the first one `last` picks, plus `after` more (the recording as the real run went, cut there) */
const through = (scenario: string, last: (f: Frame) => boolean, after = 0): Recording => {
  const recording = loadRecording(file(scenario))
  return { ...recording, frames: recording.frames.slice(0, recording.frames.findIndex(last) + 1 + after) }
}
/** The text the recorded run's first `turn/start` carried, which the replay expects the adapter to send again */
const promptOf = (scenario: string): string => {
  const sent = loadRecording(file(scenario)).frames.find(isOut('turn/start'))!.msg!.params as { input: { text: string }[] }
  return sent.input[0]!.text
}
/** The run of `die` without its own end (the process killed): the test ends it */
const dying = (): Recording => {
  const recording = loadRecording(file('die'))
  return { ...recording, frames: recording.frames.filter((f) => f.dir !== 'exit') }
}

const folders: { remove(): void }[] = []
afterEach(() => folders.splice(0).forEach((f) => f.remove()))

function open(recording: Recording) {
  const folder = temporaryFolder('codex-idle-exit-')
  folders.push(folder)
  const { spawn, state, peers } = replaySpawner(recording, codexCodec(folder.path))
  wire.spawn = spawn
  const events: NormalizedEvent[] = []
  const created = new CodexAdapter().createSession(
    { sessionId: 's1', cwd: folder.path, permissionPreset: recording.header.preset as 'normal', projectTrusted: true, ...CODEX_REPLAY_SESSION },
    (e) => events.push(e),
  )
  // A session that never opened rejects; the events say how
  created.catch(() => {})
  return { events, state, created, peer: () => peers.at(-1)! }
}

/** Waits for the replay to have taken every recorded line, so the process is where the recording left it */
const reached = (state: { left(): number; problems: string[] }) => vi.waitFor(() => expect([state.left(), state.problems]).toEqual([0, []]))
const exit = (peer: ReplayPeer, code: number | null) => {
  Object.assign(peer, { exitCode: code })
  peer.emit('exit', code, null)
}
const asleep = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'session_live' && !e.live && e.reason === 'asleep')
const crashes = (events: NormalizedEvent[]) => events.flatMap((e) => (e.type === 'error' && e.error.code === 'adapter_crashed' ? [e.error] : []))
/** Waits for how the exit was said, either way, rather than for a fixed time */
const exitSaid = (events: NormalizedEvent[]) => vi.waitFor(() => expect(asleep(events).length + crashes(events).length).toBeGreaterThan(0))

describe('a Codex app-server that exits on its own', () => {
  it.each([0, 1])('is asleep, with no error, when it exits (code %i) between turns', async (code) => {
    const { events, state, created, peer } = open(through('basic', (f) => f.dir === 'in' && f.msg?.method === 'turn/completed'))
    const handle = await created
    handle.send(promptOf('basic'))
    await reached(state)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_complete')).toBe(true))
    exit(peer(), code)
    await exitSaid(events)
    expect(asleep(events)).toHaveLength(1)
    expect(crashes(events)).toHaveLength(0)
  })

  it.each([0, 1])('is a crash when it exits (code %i) in the middle of a turn', async (code) => {
    const { events, state, created, peer } = open(dying())
    const handle = await created
    handle.send(promptOf('die'))
    await reached(state)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'message_delta' || e.type === 'reasoning_delta')).toBe(true))
    exit(peer(), code)
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it.each([0, 101])('is a crash when it exits (code %i) before it answered the message just sent', async (code) => {
    const { events, state, created, peer } = open(through('basic', isOut('turn/start')))
    const handle = await created
    handle.send(promptOf('basic'))
    await reached(state)
    exit(peer(), code)
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash when it exits in the same tick as a message is sent: nothing between the send and its turn/start is idle', async () => {
    const { events, state, created, peer } = open(through('basic', isOut('thread/start'), 1))
    const handle = await created
    await reached(state)
    handle.send(promptOf('basic'))
    exit(peer(), 101)
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash when it exits while a compact runs, before the app-server says a turn started for it', async () => {
    const { events, state, created, peer } = open(through('compact', isOut('thread/compact/start'), 1))
    const handle = await created
    // The recorded run talks first, then asks for the compact
    handle.send(promptOf('compact'))
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_complete')).toBe(true))
    handle.send('/compact')
    await reached(state)
    exit(peer(), 0)
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash when it exits before the thread is open: it may never have started', async () => {
    const { events, state, peer } = open(through('basic', isOut('thread/start')))
    await reached(state)
    exit(peer(), 0)
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  // A recording keeps the frames on the wire, not the process's stderr, so this line is written here
  it('says why from the end of its stderr when it crashes (#428)', async () => {
    const { events, state, created, peer } = open(dying())
    const handle = await created
    handle.send(promptOf('die'))
    await reached(state)
    Object.assign(peer(), { stderrTail: () => 'Error: thread already has an active writer\n' })
    exit(peer(), 1)
    await exitSaid(events)
    expect(crashes(events)[0]).toMatchObject({ message: 'codex app-server exited (code 1). stderr: Error: thread already has an active writer' })
  })
})
