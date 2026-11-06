import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { SessionHandle } from '../contract.js'
import { SLOW } from '../../../../../tooling/test-timing.js'
import { centraluInputId } from '../input-receipts.js'
import { ENDED, PROBLEM, REPLAYED, recordingFile, replayAdapters } from './replay-agent.test-helpers.js'
import { loadRecording, replaySpawner, temporaryFolder, type ReplayPeer } from './replay.test-helpers.js'

/**
 * The recorded session a host runs as its agent (#1498): the real Claude adapter on `basic`, started the way the session
 * manager starts one, so what comes out is what the adapter makes of the frames the CLI sent.
 */

const folders: { remove(): void }[] = []
afterEach(() => {
  vi.restoreAllMocks()
  folders.splice(0).forEach((f) => f.remove())
})

/** A project folder named `name`: the scenario a session in it replays */
function project(name: string): string {
  const root = temporaryFolder('replay-agent-')
  folders.push(root)
  return `${root.path}/${name}`
}

const open = async (cwd: string, preset: 'edits' | 'normal' | 'auto' = 'edits', tool: 'claude' | 'codex' = 'claude') => {
  const events: NormalizedEvent[] = []
  /** The inputs each start of a turn was announced for, as the host reads them as the event arrives */
  const started: (readonly string[])[] = []
  const adapter = replayAdapters().get(tool)!
  const handle: SessionHandle = await adapter.createSession({ sessionId: 's1', cwd, permissionPreset: preset, projectTrusted: true }, (e) => {
    events.push(e)
    if (e.type === 'state_change' && e.state === 'working') started.push(handle.turnStartInputs?.() ?? [])
  })
  const next = (pick: (e: NormalizedEvent) => boolean) => vi.waitFor(() => expect(events.some(pick)).toBe(true), { timeout: 10_000 * SLOW })
  return { adapter, handle, events, next, started }
}

describe('a recorded session as the agent of a host', () => {
  it('answers a prompt with what the adapter makes of the recorded CLI frames', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)))
    const { handle, events, next } = await open(project('basic'))
    handle.send('Reply with exactly: hello')
    await next((e) => e.type === 'turn_complete')
    expect(events.filter((e) => e.type === 'message_delta').map((e) => (e.type === 'message_delta' ? e.text : ''))).toEqual(['hello'])
    expect(lines.filter((l) => l.startsWith(PROBLEM))).toEqual([])
    await handle.dispose()
  })

  it('says a frame the adapter sends that the recording does not hold, as it happens', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)))
    const { handle } = await open(project('basic'))
    handle.send('Say something the recording does not hold')
    // Naming the recording, its line and where the two differ (#2068)
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith(`${PROBLEM} basic: claude-code-`) && l.includes('line 3: the message: first difference at content[0].text') && l.includes('the adapter sent "Say something the recording does not hold"'))).toBe(true), { timeout: 10_000 * SLOW })
    await handle.dispose()
  })

  it('says how many recorded frames a process that ended was not given', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)))
    const { handle } = await open(project('basic'))
    // Stopped before it was given its first message: all of the recording is left, in the one process it holds
    await handle.dispose()
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith(`${ENDED} basic: own=`) && !l.includes('own=0'))).toBe(true), { timeout: 10_000 * SLOW })
  })

  it('refuses a folder named after no recording, naming the ones there are', async () => {
    const adapter = replayAdapters().get('claude')!
    await expect(adapter.createSession({ sessionId: 's2', cwd: project('no-such-scenario'), permissionPreset: 'normal' }, () => {})).rejects.toThrow(/no claude recording "no-such-scenario".*recorded: .*basic/)
  })

  it('plays a Codex recording to a session as a host drives it: the commands asked for and the messages it names are not problems', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)))
    const { handle, events, next, started } = await open(project('basic'), 'auto', 'codex')
    // The recording of the adapter alone asked for no commands and named no message; a host does both
    const commands = await handle.listCommands?.()
    // A recording of the adapter alone holds no answer to skills/list: the one an app-server gave a host stands for it
    expect(commands?.map((c) => c.name)).toEqual(expect.arrayContaining(['compact', 'imagegen', 'skill-creator']))
    const id = centraluInputId()
    handle.send('Reply with exactly: hello', { id })
    await next((e) => e.type === 'turn_complete')
    expect(events.find((e) => e.type === 'message_delta')).toMatchObject({ text: 'hello' })
    // The app-server's echo of the message carries its name, which is how the adapter knows that turn started it
    expect(started).toContainEqual([id])
    expect(lines.filter((l) => l.startsWith(PROBLEM))).toEqual([])
    await handle.dispose()
  })

  describe('the Codex codec of a recording made through a host', () => {
    const codec = (scenario: string) => {
      const row = REPLAYED.find((r) => r.tool === 'codex')!
      const recording = loadRecording(recordingFile(row, scenario))
      const start = recording.frames.find((f) => f.dir === 'out' && f.msg?.method === 'thread/start')!.msg!
      return { codec: row.codec('/replay', recording), start }
    }

    it('accepts a name the host gives a message only where the recording is of the driver alone', () => {
      const steer = { method: 'turn/steer', params: { threadId: 't', expectedTurnId: 'u', input: [], clientUserMessageId: 'mine' } }
      const recorded = { ...steer, params: { ...steer.params, clientUserMessageId: undefined } }
      const named = (scenario: string) => codec(scenario).codec.match(steer, recorded, new Map())
      expect(named('basic')).toBeNull()
      expect(named('centralu-read')).toMatch(/with an input id where the recording has none/)
    })

    it('compares the thread’s config but for the host-made values: the bridge, the trust list and the compaction limit', () => {
      const { codec: c, start } = codec('centralu-read')
      const config = (start.params as { config: object }).config as { mcp_servers: Record<string, unknown> } & Record<string, unknown>
      const sent = (changes: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...start, params: { ...(start.params as object), cwd: '/replay', config: { ...config, ...changes } } })) as typeof start
      expect(c.match(sent({ mcp_servers: { centralu: { url: 'http://127.0.0.1:1/another-address' } }, projects: {}, model_auto_compact_token_limit: 1 }), start, new Map())).toBeNull()
      // A replay host offers no bridge, so its thread has no centralu server at all
      expect(c.match(sent({ mcp_servers: undefined }), start, new Map())).toBeNull()
      expect(c.match(sent({ model_reasoning_summary: 'none' }), start, new Map())).toMatch(/model_reasoning_summary/)
      expect(c.match(sent({ project_doc_max_bytes: 1 }), start, new Map())).toMatch(/project_doc_max_bytes/)
    })
  })

  it('says nothing to a process that has ended, as a real one would not hear it: a host shared by many tests deletes sessions while a query is on its way', async () => {
    const row = REPLAYED.find((r) => r.tool === 'codex')!
    const recording = loadRecording(recordingFile(row, 'basic'))
    const peer = replaySpawner(recording, row.codec('/replay', recording)).spawn({ command: 'codex', args: [], cwd: '/replay', env: {} }) as ReplayPeer
    // Nothing reads the output, so the stream is ended but not yet destroyed: a write to it is an error event
    const errors: Error[] = []
    peer.stdout.on('error', (e) => errors.push(e))
    peer.kill()
    await new Promise((resolve) => setImmediate(resolve))
    // The adapter's query reaches the process after it ended: the answer to it has nowhere to go
    peer.stdin.write('{"id":"q1","method":"skills/list","params":{}}' + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual([])
  })

  it('leaves out what a replay has no use for: the machine’s own CLI is not asked for its version or usage', async () => {
    const adapter = replayAdapters().get('claude')!
    expect(adapter.installedVersion).toBeUndefined()
    expect(adapter.listUsage).toBeUndefined()
    expect(await adapter.detect()).toMatchObject({ tool: 'claude', installed: true, loggedIn: true })
  })
})
