import { afterEach, describe, expect, it } from 'vitest'
import { replaySpawner } from '../frames/replay.test-helpers.js'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import type { AgentSpawnSpec } from '../contract.js'
import { agyRecording, fakeInstall, fakeSignIn, HOST_TEST_ARCHIVE, HOST_TEST_PLATFORM, pathIn, tempData, write } from './agent-files.test-helpers.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { agyUsageSnapshot, readAgyQuota, readAgyUsage, type AgyQuota } from './usage.js'

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

const SAMPLE_MARKDOWN = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 29, 2026, 09:18 UTC)
  - **Five Hour Limit Remaining:** 80% remaining (resets Nov 22, 2026, 14:18 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B)*
  - **Weekly Limit Remaining:** 75.5% remaining (resets Nov 29, 2026, 09:18 UTC)
  - **Five Hour Limit Remaining:** 50% remaining (resets Nov 22, 2026, 14:18 UTC)
- **Gemini 4 Argon**
  *(For paid Pro plans, Argon quota is separate.)*
  - **Gemini 4 Argon Weekly Limit:** 90% remaining (resets Nov 29, 2026, 09:18 UTC)`

describe('Antigravity quota parser (readAgyQuota)', () => {
  it('reads the Quota Limits section and ignores other sections and notes', () => {
    const quota = readAgyQuota(SAMPLE_MARKDOWN)
    expect(quota).toHaveLength(3)
    expect(quota[0]?.name).toBe('Gemini Models')
    expect(quota[0]?.buckets).toEqual([
      { label: 'Weekly Limit Remaining', remaining: 100, resetsAt: '2026-11-29T09:18:00.000Z' },
      { label: 'Five Hour Limit Remaining', remaining: 80, resetsAt: '2026-11-22T14:18:00.000Z' },
    ])
    expect(quota[1]?.name).toBe('Claude and GPT models')
    expect(quota[1]?.buckets).toEqual([
      { label: 'Weekly Limit Remaining', remaining: 75.5, resetsAt: '2026-11-29T09:18:00.000Z' },
      { label: 'Five Hour Limit Remaining', remaining: 50, resetsAt: '2026-11-22T14:18:00.000Z' },
    ])
    expect(quota[2]?.name).toBe('Gemini 4 Argon')
    expect(quota[2]?.buckets).toEqual([
      { label: 'Gemini 4 Argon Weekly Limit', remaining: 90, resetsAt: '2026-11-29T09:18:00.000Z' },
    ])
  })

  it('refuses when a line kind is unknown in the quota section', () => {
    const bad = `### Quota Limits\n- **Gemini Models**\nsome unexpected text\n  - **Weekly Limit Remaining:** 100% remaining (resets Nov 29, 2026, 09:18 UTC)`
    expect(() => readAgyQuota(bad)).toThrow('Antigravity\'s usage answer has a form Centralu does not read (a line of a kind it does not know)')
  })

  it('refuses when a limit line appears before any group', () => {
    const bad = `### Quota Limits\n- **Weekly Limit Remaining:** 100% remaining (resets Nov 29, 2026, 09:18 UTC)`
    expect(() => readAgyQuota(bad)).toThrow('Antigravity\'s usage answer has a form Centralu does not read (a limit before any group)')
  })

  it('refuses when reset date is not in standard UTC format', () => {
    const bad = `### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 100% remaining (resets Tomorrow)`
    expect(() => readAgyQuota(bad)).toThrow('Antigravity\'s usage answer has a form Centralu does not read (a reset time)')
  })

  it('refuses when no Quota Limits section or groups are found', () => {
    expect(() => readAgyQuota('### Session Usage\n- **Session total:** none')).toThrow('no limits')
  })
})

describe('Antigravity usage snapshot (agyUsageSnapshot)', () => {
  it('turns quota buckets into usage windows scoped by model group', () => {
    const quota: AgyQuota = [
      {
        name: 'Gemini Models',
        buckets: [{ label: 'Weekly Limit Remaining', remaining: 85, resetsAt: '2026-11-29T09:18:00.000Z' }],
      },
    ]
    const snapshot = agyUsageSnapshot(quota, 'Pro')
    expect(snapshot.plan).toBe('Pro')
    expect(snapshot.windows).toEqual([
      { id: 'gemini-models:weekly', label: 'Weekly', percent: 15, resetsAt: '2026-11-29T09:18:00.000Z', scope: 'Gemini Models' },
    ])
    expect(snapshot.daily).toEqual([])
  })
})

describe('readAgyUsage with recorded and scripted peers', () => {
  it('replays usage.jsonl and extracts the measured quota', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    const rec = agyRecording('usage')
    const { spawn } = replaySpawner(rec)
    const quota = await readAgyUsage(temp.home, HOST_TEST_ARCHIVE, () => new Error('signed out'), { spawn, platform: HOST_TEST_PLATFORM })
    expect(quota).toHaveLength(3)
    expect(quota[0]?.name).toBe('Gemini Models')
    expect(quota[0]?.buckets[0]?.remaining).toBe(100)
  })

  it('adapter.listUsage exposes limits and shares concurrent reads', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    const rec = agyRecording('usage')
    let spawns = 0
    const { spawn } = replaySpawner(rec)
    const countingSpawn = (spec: AgentSpawnSpec) => {
      spawns++
      return spawn(spec)
    }
    const profile = antigravityProfile({ dataDir: temp.dir, platform: HOST_TEST_PLATFORM, arch: 'x64', usage: { spawn: countingSpawn } })
    const adapter = new AntigravityAdapter(profile, countingSpawn)

    const [first, second] = await Promise.all([adapter.listUsage!(), adapter.listUsage!()])
    expect(first).toEqual(second)
    expect(first).not.toBe('no-limits')
    if (first !== 'no-limits') {
      expect(first.windows.length).toBeGreaterThan(0)
    }
    expect(spawns).toBe(1)
  })

  it('fails if availableCommands does not advertise usage', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    const script: PeerScript = (method, _params, peer) => {
      if (method === 'initialize') return { result: { protocolVersion: 1 } }
      if (method === 'session/new') {
        peer.update('ses-1', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan' }] })
        return { result: { sessionId: 'ses-1' } }
      }
      return { result: null }
    }
    const spawn = () => new FakeAcpPeer(script)
    await expect(readAgyUsage(temp.home, HOST_TEST_ARCHIVE, () => new Error('signed out'), { spawn, platform: HOST_TEST_PLATFORM }))
      .rejects.toThrow('Antigravity does not support "/usage" in this version')
  })

  it('rejects if the agent answers "/usage" with a tool call', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    const script: PeerScript = (method, _params, peer) => {
      if (method === 'initialize') return { result: { protocolVersion: 1 } }
      if (method === 'session/new') {
        peer.update('ses-1', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'usage' }] })
        return { result: { sessionId: 'ses-1' } }
      }
      if (method === 'session/prompt') {
        peer.update('ses-1', { sessionUpdate: 'tool_call', toolCallId: 'c-1', tool: 'some_tool' })
        return { result: { stopReason: 'end_turn' } }
      }
      return { result: null }
    }
    const spawn = () => new FakeAcpPeer(script)
    await expect(readAgyUsage(temp.home, HOST_TEST_ARCHIVE, () => new Error('signed out'), { spawn, platform: HOST_TEST_PLATFORM }))
      .rejects.toThrow('Antigravity answered "/usage" with a tool call, not its usage')
  })

  it('falls back to session/new when session/resume fails and writes the new id', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    // Pre-seed usage-session.json with a stale id
    write(pathIn(temp.home.root, 'usage-session.json'), JSON.stringify({ sessionId: 'stale-ses' }))

    const methodsCalled: string[] = []
    const script: PeerScript = (method, _params, peer) => {
      methodsCalled.push(method)
      if (method === 'initialize') return { result: { protocolVersion: 1 } }
      if (method === 'session/resume') return { error: { code: -32001, message: 'session not found' } }
      if (method === 'session/new') {
        setTimeout(() => {
          peer.update('new-ses', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'usage' }] })
        }, 10)
        return { result: { sessionId: 'new-ses' } }
      }
      if (method === 'session/prompt') {
        peer.update('new-ses', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: SAMPLE_MARKDOWN } })
        return { result: { stopReason: 'end_turn' } }
      }
      return { result: null }
    }
    const spawn = () => new FakeAcpPeer(script)
    const quota = await readAgyUsage(temp.home, HOST_TEST_ARCHIVE, () => new Error('signed out'), { spawn, platform: HOST_TEST_PLATFORM })
    expect(quota).toHaveLength(3)
    expect(methodsCalled).toContain('session/resume')
    expect(methodsCalled).toContain('session/new')
  })

  it('rejects when read times out', async () => {
    const temp = tempData()
    data.push(temp)
    fakeInstall(temp.home, HOST_TEST_ARCHIVE)
    fakeSignIn(temp.home)
    const script: PeerScript = (method) => {
      if (method === 'initialize') return { hold: true }
      return { result: null }
    }
    const spawn = () => new FakeAcpPeer(script)
    await expect(readAgyUsage(temp.home, HOST_TEST_ARCHIVE, () => new Error('signed out'), { spawn, platform: HOST_TEST_PLATFORM, timeoutMs: 100 }))
      .rejects.toThrow('Antigravity did not say its usage within')
  })
})
