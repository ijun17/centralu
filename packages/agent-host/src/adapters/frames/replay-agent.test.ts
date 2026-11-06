import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { SLOW } from '../../../../../tooling/test-timing.js'
import { ENDED, PROBLEM, replayAdapters } from './replay-agent.test-helpers.js'
import { temporaryFolder } from './replay.test-helpers.js'

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

const open = async (cwd: string, preset: 'edits' | 'normal' = 'edits') => {
  const events: NormalizedEvent[] = []
  const adapter = replayAdapters().get('claude')!
  const handle = await adapter.createSession({ sessionId: 's1', cwd, permissionPreset: preset, projectTrusted: true }, (e) => events.push(e))
  const next = (pick: (e: NormalizedEvent) => boolean) => vi.waitFor(() => expect(events.some(pick)).toBe(true), { timeout: 10_000 * SLOW })
  return { adapter, handle, events, next }
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

  it('leaves out what a replay has no use for: the machine’s own CLI is not asked for its version or usage', async () => {
    const adapter = replayAdapters().get('claude')!
    expect(adapter.installedVersion).toBeUndefined()
    expect(adapter.listUsage).toBeUndefined()
    expect(await adapter.detect()).toMatchObject({ tool: 'claude', installed: true, loggedIn: true })
  })
})
