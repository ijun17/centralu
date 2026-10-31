import { describe, expect, it } from 'vitest'
import { launchRefusal, type AdapterCapabilities, type PermissionPreset } from '@cc/protocol'
import type { AgentSpawnSpec } from '../contract.js'
import { cursorProfile } from '../cursor-agent/index.js'
import { antigravityProfile } from '../antigravity/index.js'
import { openCodeProfile } from '../opencode/index.js'
import { AcpAdapter } from './adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from './fake-peer.test-helpers.js'
import { ACP_CAPABILITIES, type AcpProfile } from './profile.js'

/**
 * What the ACP adapter starts a tool with, and what Cursor's profile lets it start under. The real-process side of each
 * is in `ends-with-host.test.ts` and `smoke:cursor`; these hold the declarations themselves (#1562 Mac re-check: removing
 * either passed every unit test).
 */

class FakeAdapter extends AcpAdapter {
  readonly tool = 'fake'
}

const script: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: 'ses-a' } }
  return { result: null }
}

const profile: AcpProfile = {
  descriptor: { name: 'fake', label: 'Fake', mark: 'F', install: 'install it', login: 'log in' },
  capabilities: { approvals: true, contextUsage: 'none', resume: true, autoTitle: true } as AdapterCapabilities,
  surface: undefined as never,
  launch: async () => ({ command: 'fake', args: ['acp'] }),
  detect: async () => ({ tool: 'fake', installed: true, loggedIn: true, detail: '' }),
  installedVersion: async () => '0.0.1',
}

async function startedWith(processSource: boolean): Promise<AgentSpawnSpec> {
  const specs: AgentSpawnSpec[] = []
  const spawn = (spec: AgentSpawnSpec) => (specs.push(spec), new FakeAcpPeer(script))
  const adapter = new FakeAdapter(profile, spawn, 60_000)
  const s = await adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'auto', projectTrusted: true, ...(processSource ? { processSource: { spawn } } : {}) }, () => {})
  await s.dispose()
  return specs[0]!
}

describe('the ACP adapter', () => {
  it('starts a tool it spawns itself to end with this host', async () => {
    expect((await startedWith(false)).endsWithHost).toBe(true)
  })

  it('leaves a process the keeper holds to the keeper, which outlives the host by design', async () => {
    expect((await startedWith(true)).endsWithHost).toBeUndefined()
  })
})

describe("Cursor's presets", () => {
  const caps = cursorProfile().capabilities
  const refusal = (permissionPreset: PermissionPreset) => launchRefusal(caps, 'Cursor', { permissionPreset, projectTrusted: true })

  it('start it under Auto only: it writes without asking, so no preset that asks before a change can be kept', () => {
    expect(refusal('auto')).toBeNull()
    for (const p of ['safe', 'normal', 'edits'] as const) expect(refusal(p)).toMatch(/only under Auto/)
  })
})

describe('what the ACP tools keep alike', () => {
  it('is ACP_CAPABILITIES for all three, each overriding only what it measured different', () => {
    expect(cursorProfile().capabilities).toStrictEqual({ ...ACP_CAPABILITIES, contextUsage: 'none', presets: ['auto'] })
    expect(openCodeProfile().capabilities).toStrictEqual(ACP_CAPABILITIES)
    expect(antigravityProfile().capabilities).toStrictEqual({ ...ACP_CAPABILITIES, autoTitle: false })
    expect(ACP_CAPABILITIES).toMatchObject({ approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, midTurnInput: false, instructionChannel: 'server', processModel: 'per-session', roleText: false })
  })
})

describe('what an ACP tool says about its usage (#1623)', () => {
  it('never has listUsage, the one definition of a tool that reports no limits; localUsage is only what its profile gives', () => {
    expect('listUsage' in new FakeAdapter(profile)).toBe(false)
    expect(new FakeAdapter(profile).localUsage).toBeUndefined()
    const given = new FakeAdapter({ ...profile, localUsage: async () => ({ plan: 'Free' }) })
    expect('listUsage' in given).toBe(false)
    expect(given.localUsage).toBeTypeOf('function')
  })

  it("is Cursor's and OpenCode's own: a local usage and no limits", () => {
    for (const p of [cursorProfile(), openCodeProfile()]) {
      const a = new FakeAdapter(p)
      expect('listUsage' in a).toBe(false)
      expect(a.localUsage).toBeTypeOf('function')
    }
  })
})
