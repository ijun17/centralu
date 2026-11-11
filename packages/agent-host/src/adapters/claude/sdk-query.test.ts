import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { claudeAutoCompactWindow, claudeCompactAt, claudeQueryOptions, compactPointOff, flagSettings } from './sdk-query.js'
import type { CreateSessionOpts } from '../contract.js'
import { TOOL_PROFILES } from '../../sessions/tool-cost.js'
import { toolDefsFor } from '../../sessions/tool-seats.js'

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
  const options = (autoCompactTokens?: number, more: Partial<CreateSessionOpts> = {}) =>
    claudeQueryOptions({
      sessionId: 's1',
      opts: { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', ...(autoCompactTokens ? { autoCompactTokens } : {}), ...more },
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

  it("turn the CLI's own choice tool off for a session that asks the person by mail, and only for one (#1630)", () => {
    const tools = {} as NonNullable<CreateSessionOpts['centraluTools']>
    expect(options(undefined, { centraluTools: tools, toolProfile: 'reader' }).disallowedTools).toContain('AskUserQuestion')
    expect(options(undefined, { centraluTools: tools }).disallowedTools).toContain('AskUserQuestion')
    // A builder has no mail, nor has a session without Centralu's tools: the card stays theirs
    expect(options(undefined, { centraluTools: tools, toolProfile: 'builder' }).disallowedTools).not.toContain('AskUserQuestion')
    expect(options().disallowedTools).not.toContain('AskUserQuestion')
  })
})

describe('a session whose choice tool is off is told how to ask (#1630)', () => {
  const off = (toolProfile: (typeof TOOL_PROFILES)[number]) =>
    claudeQueryOptions({
      sessionId: 's1',
      opts: { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', centraluTools: {} as NonNullable<CreateSessionOpts['centraluTools']>, toolProfile },
      executablePath: undefined,
      servers: {},
      permissionOptions: { permissionMode: 'default' },
      codeIntelligence: {},
      spawn: () => {
        throw new Error('not started')
      },
      canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: '' }),
    }).disallowedTools?.includes('AskUserQuestion') === true

  it('says it in the mail tool, for every seat that is served the tool', () => {
    const served = TOOL_PROFILES.filter((p) => off(p) && toolDefsFor(p).some((t) => t.name === 'mail'))
    expect(served).toContain('reader')
    for (const p of served) expect(toolDefsFor(p).find((t) => t.name === 'mail')?.description).toContain('Ask the person with kind "question".')
  })
})

describe('thinking (#2062)', () => {
  it('asks the CLI for summarized thinking text, through the flag the SDK starts it with', () => {
    const specs: { args: string[] }[] = []
    const o = claudeQueryOptions({
      sessionId: 's1',
      opts: { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
      executablePath: '/nowhere/claude',
      servers: {},
      permissionOptions: { permissionMode: 'default' },
      codeIntelligence: {},
      spawn: (spec) => {
        specs.push(spec)
        throw new Error('not started')
      },
      canUseTool: () => Promise.resolve({ behavior: 'deny' as const, message: '' }),
    })
    // The real SDK builds the command line: the flag has to survive it, not only sit in the options
    expect(() => query({ prompt: 'hi', options: o })).toThrow('not started')
    const args = specs[0]?.args ?? []
    const at = args.indexOf('--thinking-display')
    expect(at).toBeGreaterThan(-1)
    expect(args[at + 1]).toBe('summarized')
    // And whether the model thinks stays the CLI's and the model's to decide
    expect(args).not.toContain('--thinking')
  })
})

describe("the CLI's process", () => {
  it('hands the SDK spec to the start as it is, which adds the host watch (#1654 Q3)', () => {
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
    expect(specs).toEqual([{ command: 'claude', args: ['-p'], env: {} }])
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
