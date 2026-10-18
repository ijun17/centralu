import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { baselineSource, compareSurface } from '../surface-drift.js'
import { CLAUDE_KNOWN_TYPES } from './normalize.js'
import { CLAUDE_LIMITATIONS, CLAUDE_SURFACE, initSurfaceLines, readClaudeSurface } from './surface.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

const fixture = (name: string) => readFileSync(new URL(`../surface-fixtures/${name}`, import.meta.url), 'utf8')

// Recorded 2026-10-18: SDK 0.3.302 (an excerpt of its sdk.d.ts) and Claude Code 2.1.302's --version and --help
const recorded = {
  'package.json': JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.302' }),
  'sdk.d.ts': fixture('claude-sdk-0.3.302-excerpt.d.ts.txt'),
  'claude --version': '2.1.302 (Claude Code)\n',
  'claude --help': fixture('claude-2.1.302-help.txt'),
}
const surface = readClaudeSurface(recorded)

/** The SDK's own framing: control requests and keep-alives the SDK answers itself, before the adapter's message loop */
const SDK_FRAMING = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive'])

describe('the Claude surface', () => {
  it('names the CLI and the SDK it was read from', () => {
    expect(surface.version).toBe('2.1.302 (Claude Code) · SDK 0.3.302')
  })

  it('keys messages as normalize.ts does: the type, or system/<subtype>', () => {
    expect(surface.offered.message).toEqual(expect.arrayContaining(['assistant', 'result', 'active_goal', 'system/init', 'system/compact_boundary']))
    expect(surface.offered.message).not.toContain('system')
  })

  it('reads the options, the Query methods and the CLI flags and subcommands as capabilities', () => {
    expect(surface.offered.capability).toEqual(
      expect.arrayContaining(['option:resume', 'query:supportedCommands', 'flag:--permission-mode', 'subcommand:mcp']),
    )
  })

  it('leaves commands to the init message: nothing a CLI prints without a session lists them', () => {
    expect(surface.offered.command).toBeUndefined()
    expect(SURFACE_BASELINE.offered.command).toBeUndefined()
  })

  it('falls back to SDKMessage in an SDK without the stdout union', () => {
    const older = readClaudeSurface({ ...recorded, 'sdk.d.ts': recorded['sdk.d.ts'].replace(/declare type StdoutMessage =/, 'declare type Gone =') })
    expect(older.offered.message).not.toContain('active_goal')
    expect(older.offered.message).toContain('assistant')
  })

  it('throws when an input is missing, rather than reading an empty surface', () => {
    const { ['claude --help']: _help, ...rest } = recorded
    expect(() => readClaudeSurface(rest)).toThrow(/needs claude --help/)
  })

  it('is what the adapter declares in the contract', () => {
    expect(CLAUDE_SURFACE.read).toBe(readClaudeSurface)
    expect(CLAUDE_SURFACE.limitations).toBe(CLAUDE_LIMITATIONS)
  })
})

describe('what the Claude adapter writes down', () => {
  /*
   * The rule that keeps the list honest: what was reviewed is accounted for. A type the SDK adds reaches the drift run's
   * issue first (it is not in the baseline); re-recording the baseline without sorting it fails here.
   */
  it.each([
    ['the reviewed baseline', SURFACE_BASELINE.offered.message],
    ['the recorded 0.3.302 union', surface.offered.message],
  ])('every message type in %s is mapped, ignored on purpose, or a limitation', (_, messages) => {
    const limited = new Set(CLAUDE_LIMITATIONS.filter((l) => l.kind === 'message').map((l) => l.name))
    const unaccounted = (messages ?? []).filter((m) => !CLAUDE_KNOWN_TYPES.has(m) && !limited.has(m) && !SDK_FRAMING.has(m))
    expect(unaccounted).toEqual([])
  })

  it('a dropped type stays out of the known set, so its first real instance is still logged', () => {
    for (const l of CLAUDE_LIMITATIONS.filter((x) => x.treatment === 'dropped')) expect(CLAUDE_KNOWN_TYPES.has(l.name), l.name).toBe(false)
  })

  it('every limitation on a name offered when measured is still offered by the recorded surface', () => {
    const stale = compareSurface(surface, CLAUDE_LIMITATIONS).filter((f) => f.sort === 'stale')
    expect(stale).toEqual([])
  })

  it('the baseline is in the form drift:surface --record writes', () => {
    expect(readFileSync(new URL('./surface-baseline.ts', import.meta.url), 'utf8')).toBe(baselineSource(SURFACE_BASELINE, SURFACE_BASELINE.recorded))
  })
})

describe('initSurfaceLines', () => {
  // An excerpt of an init message's slash_commands from CLI 2.1.282 (2026-10-03, #270)
  const init = ['clear', 'compact', 'context', 'goal', 'review', 'usage']

  it('says nothing of /goal: the session already sends it when the CLI offers it', () => {
    expect(initSurfaceLines('0123456789ab', init)).toEqual([])
  })

  it('says a command limitation the CLI now lists, once per line', () => {
    const blocked = { ...CLAUDE_LIMITATIONS.find((l) => l.name === 'goal')!, followsOffer: false }
    expect(initSurfaceLines('0123456789ab', init, [blocked])).toEqual([
      '[claude] 01234567 the tool now offers command goal, which the adapter blocks (measured 2026-09-07, SDK 0.3.231 and 0.3.263); it may no longer need to',
    ])
  })

  it('ignores entries that are not names', () => {
    const blocked = { ...CLAUDE_LIMITATIONS.find((l) => l.name === 'goal')!, followsOffer: false }
    expect(initSurfaceLines('0123456789ab', [{ name: 'goal' }, 7], [blocked])).toEqual([])
  })
})
