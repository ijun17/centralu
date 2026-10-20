import { afterEach, describe, expect, it, vi } from 'vitest'
import { withoutCrossSessionMessaging } from './cross-session.js'

afterEach(() => vi.unstubAllEnvs())

describe('Claude cross-session controls', () => {
  it('merges refusal and discovery denies without losing settings, tool denies or environment', () => {
    vi.stubEnv('CC_PEER_PROBE_INHERITED', 'inherited')
    vi.stubEnv('CLAUDE_CODE_HARBOR_KITE', '1')
    const options = {
      cwd: '/tmp',
      settingSources: ['user' as const],
      settings: { crossSessionInbound: 'accept' as const, permissions: { ask: ['Bash(*)'] }, env: { KEEP_SETTING: 'yes' } },
      disallowedTools: ['WebFetch', 'ListAgents'],
      env: { KEEP_ENV: 'yes', CLAUDE_CODE_HARBOR_KITE: '1' },
    }
    const result = withoutCrossSessionMessaging(options)
    expect(result.settings).toEqual({ ...options.settings, crossSessionInbound: 'refuse' })
    expect(result.disallowedTools).toEqual(['WebFetch', 'ListAgents', 'ListPeers'])
    expect(result.disallowedTools).not.toContain('SendMessage')
    expect(result.env.CC_PEER_PROBE_INHERITED).toBe('inherited')
    expect(result.env.KEEP_ENV).toBe('yes')
    expect(result.env.CLAUDE_CODE_HARBOR_KITE).toBe('0')
    expect(result.cwd).toBe(options.cwd)
    expect(result.settingSources).toBe(options.settingSources)
    expect(options.settings.crossSessionInbound).toBe('accept')
    expect(options.disallowedTools).toEqual(['WebFetch', 'ListAgents'])
    expect(options.env.CLAUDE_CODE_HARBOR_KITE).toBe('1')
    expect(process.env.CLAUDE_CODE_HARBOR_KITE).toBe('1')
  })

  it('refuses peers under every preset, auto included: the options do not depend on the preset', () => {
    vi.stubEnv('CLAUDE_CODE_HARBOR_KITE', '1')
    const options = { settings: { crossSessionInbound: 'accept' as const }, disallowedTools: ['WebFetch'], env: { KEEP: 'yes' } }
    const result = withoutCrossSessionMessaging(options)
    expect(result.settings).toEqual({ crossSessionInbound: 'refuse' })
    expect(result.disallowedTools).toEqual(['WebFetch', 'ListAgents', 'ListPeers'])
    expect(result.disallowedTools).not.toContain('SendMessage')
    expect(result.env.CLAUDE_CODE_HARBOR_KITE).toBe('0')
    expect(result.env.KEEP).toBe('yes')
  })

  it('drops the inbox socket and token a host started inside a Claude session inherits, also when an option names them', () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/parent-inbox.sock')
    vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'parent-secret')
    vi.stubEnv('KEEP_ME', 'yes')
    const result = withoutCrossSessionMessaging({ env: { CLAUDE_CODE_MESSAGING_TOKEN: 'from-options' } })
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET')
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN')
    expect(result.env.KEEP_ME).toBe('yes')
    // The host's own environment is not touched
    expect(process.env.CLAUDE_CODE_MESSAGING_SOCKET).toBe('/tmp/parent-inbox.sock')
  })

  it('blocks peers when no inline settings, denies or environment were supplied', () => {
    const result = withoutCrossSessionMessaging({})
    expect(result.settings.crossSessionInbound).toBe('refuse')
    expect(result.disallowedTools).toEqual(['ListAgents', 'ListPeers'])
    expect(result.env.CLAUDE_CODE_HARBOR_KITE).toBe('0')
  })
})
