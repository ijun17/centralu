import { describe, expect, it } from 'vitest'
import { claudeAutoCompactWindow, claudeQueryOptions, flagSettings } from './sdk-query.js'

/**
 * What Claude Code is told in the flag layer (#1376): where it compacts by itself, per session and without touching a file,
 * next to the plugins that code intelligence turns off (#686). Nothing when Centralu does not set it.
 */
const off = { settings: { enabledPlugins: { 'ts-lsp': false as const } } }

describe('flagSettings', () => {
  it('passes autoCompactWindow, with auto-compact switched on so the person\'s own "off" does not defeat it', () => {
    expect(flagSettings({ autoCompactTokens: 120_000 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 133_000 } })
    expect(flagSettings({ autoCompactTokens: 600_000 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 613_000 } })
  })

  it("adds the CLI's 13,000-token buffer, so it compacts at the tokens meant, and keeps the window inside 100k to 1M", () => {
    expect(claudeAutoCompactWindow(120_000)).toBe(133_000)
    expect(claudeAutoCompactWindow(25_600)).toBe(100_000)
    expect(claudeAutoCompactWindow(990_000)).toBe(1_000_000)
    expect(flagSettings({ autoCompactTokens: 25_600 }, {})).toEqual({ settings: { autoCompactEnabled: true, autoCompactWindow: 100_000 } })
  })

  it('keeps the code intelligence plugins it already passed', () => {
    expect(flagSettings({ autoCompactTokens: 120_000 }, off)).toEqual({
      settings: { enabledPlugins: { 'ts-lsp': false }, autoCompactEnabled: true, autoCompactWindow: 133_000 },
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
    expect(options(120_000)).toMatchObject({ settings: { autoCompactWindow: 133_000, autoCompactEnabled: true } })
    // The cross-session refusal is always in the flag layer; Centralu adds nothing of its own to it
    expect(options().settings).toEqual({ crossSessionInbound: 'refuse' })
  })
})
