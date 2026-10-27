import { describe, expect, it } from 'vitest'
import { claudeAutoCompactWindow, claudeCompactAt, claudeQueryOptions, compactPointOff, flagSettings } from './sdk-query.js'

/**
 * What Claude Code is told in the flag layer (#1376): where it compacts by itself, per session and without touching a file,
 * next to the plugins that code intelligence turns off (#686). Nothing when Centralu does not set it.
 */
const off = { settings: { enabledPlugins: { 'ts-lsp': false as const } } }

describe('flagSettings', () => {
  it('passes autoCompactWindow, with auto-compact switched on so the person\'s own "off" does not defeat it', () => {
    expect(flagSettings({ autoCompactTokens: 120_000 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 153_000 } })
    expect(flagSettings({ autoCompactTokens: 600_000 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 633_000 } })
  })

  it("adds the CLI's 33,000-token buffer, so it compacts at the tokens meant, and keeps the window inside 100k to 1M", () => {
    expect(claudeAutoCompactWindow(120_000)).toBe(153_000)
    expect(claudeAutoCompactWindow(25_600)).toBe(100_000)
    expect(claudeAutoCompactWindow(990_000)).toBe(1_000_000)
    expect(flagSettings({ autoCompactTokens: 25_600 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 100_000 } })
  })

  it('keeps the code intelligence plugins it already passed', () => {
    expect(flagSettings({ autoCompactTokens: 120_000 }, off)).toEqual({
      settings: { enabledPlugins: { 'ts-lsp': false }, autoCompactEnabled: true, autoCompactWindow: 153_000 },
    })
    expect(flagSettings({}, off)).toEqual(off)
  })

  it("passes no settings at all when Centralu does not set it, so the agent's own decide", () => {
    expect(flagSettings({}, {})).toEqual({})
  })
})

describe('the options of a session\'s query', () => {
  const options = (autoCompactTokens?: number) =>
    claudeQueryOptions({
      sessionId: 's1',
      opts: { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', ...(autoCompactTokens ? { autoCompactTokens } : {}) },
      executablePath: undefined,
      servers: {},
      permissionOptions: { permissionMode: 'default' },
      codeIntelligence: {},
      spawn: () => {
        throw new Error('not started')
      },
      canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: '' }),
    })
  it('carry the setting', () => {
    expect(options(120_000)).toMatchObject({ settings: { autoCompactWindow: 153_000, autoCompactEnabled: true } })
    // The cross-session refusal is always in the flag layer; Centralu adds nothing of its own to it
    expect(options().settings).toEqual({ crossSessionInbound: 'refuse' })
  })
})

describe("the CLI's process", () => {
  it('started here, ends with this host however the host ends (#1654 Q3)', () => {
    const specs: unknown[] = []
    const o = claudeQueryOptions({
      sessionId: 's1',
      opts: { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
      executablePath: undefined,
      servers: {},
      permissionOptions: { permissionMode: 'default' },
      codeIntelligence: {},
      spawn: (spec) => {
        specs.push(spec)
        throw new Error('not started')
      },
      canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: '' }),
    })
    expect(() => o.spawnClaudeCodeProcess({ command: 'claude', args: ['-p'], env: {} })).toThrow('not started')
    expect(specs).toEqual([{ command: 'claude', args: ['-p'], env: {}, endsWithHost: true }])
  })
})

describe('compactPointOff', () => {
  it('is quiet when the CLI compacts where the window it was passed says, and says where it should when it does not', () => {
    expect(compactPointOff(153_000, 120_000, 200_000)).toBeNull()
    expect(compactPointOff(153_000, 100_000, 1_000_000)).toBe(120_000)
    expect(compactPointOff(undefined, 100_000, 200_000)).toBeNull()
  })

  it('compares an adopted process with the window it was started with, not the one a lowered setting gives now (host swap)', () => {
    // Started at 60% of 200k (passed 153,000, compacts at 120,000); the setting is lowered to 40% and the host swapped
    const nowPassed = claudeAutoCompactWindow(80_000)
    expect(compactPointOff(nowPassed, 120_000, 200_000)).not.toBeNull()
    expect(compactPointOff(153_000, 120_000, 200_000)).toBeNull()
  })

  it('does not blame the buffer for a model whose own window is smaller than the one passed', () => {
    expect(compactPointOff(633_000, 167_000, 200_000)).toBeNull()
  })
})

describe('claudeCompactAt (#1553)', () => {
  it("is the point the CLI says, not the tokens asked for: asked 40k on a 200k model it compacts at 67k", () => {
    expect(claudeCompactAt({ autoCompactTokens: 40_000 }, 67_000)).toBe(67_000)
    expect(claudeCompactAt({ autoCompactTokens: 190_000 }, 167_000)).toBe(167_000)
  })

  it('is nothing for a process Centralu did not start to compact, whatever threshold the CLI reports', () => {
    expect(claudeCompactAt({}, 167_000)).toBeUndefined()
    // An adopted process: the ceiling its host kept says whether it was; the setting now does not
    expect(claudeCompactAt({ processSource: { spawn: {} as never, adopt: {} as never }, autoCompactTokens: 120_000 }, 167_000)).toBeUndefined()
    expect(claudeCompactAt({ processSource: { spawn: {} as never, adopt: {} as never }, autoCompactCeiling: 153_000 }, 120_000)).toBe(120_000)
  })

  it('is nothing when the CLI reports no threshold', () => {
    expect(claudeCompactAt({ autoCompactTokens: 120_000 }, 0)).toBeUndefined()
  })
})
