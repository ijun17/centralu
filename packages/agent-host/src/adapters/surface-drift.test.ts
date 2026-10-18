import { describe, expect, it } from 'vitest'
import type { SurfaceBaseline, SurfaceLimitation, ToolSurface } from './contract.js'
import { baselineSource, compareSurface, findingsKey, surfaceLogLines, surfaceReport } from './surface-drift.js'

/*
 * The case #270 was opened for, as recorded: the Claude adapter refused `/goal` on the strength of a measurement from
 * 2026-09-07 (SDK 0.3.231 and 0.3.263), while the installed CLI 2.1.282 listed `goal` in its init message's
 * `slash_commands` (2026-10-03) and SDK 0.3.288 declared `active_goal` in its stdout union. The command list below is
 * an excerpt of that init message; the message lists are cut from the SDK readings.
 */
const goalBlock: SurfaceLimitation = {
  kind: 'command',
  name: 'goal',
  treatment: 'blocked',
  measured: '2026-09-07, SDK 0.3.231 and 0.3.263',
  offeredWhenMeasured: false,
  note: 'Answered here with "Goals currently need the interactive Claude CLI".',
}
const dropped = (name: string): SurfaceLimitation => ({
  kind: 'message',
  name,
  treatment: 'dropped',
  measured: '2026-10-04, CLI 2.1.282 and SDK 0.3.263 (#58 survey)',
  offeredWhenMeasured: true,
  note: 'Said once per session in host.log.',
})

const before: SurfaceBaseline = {
  recorded: '2026-09-07',
  version: '2.1.263 (Claude Code) · SDK 0.3.263',
  offered: {
    message: ['assistant', 'result', 'system/init', 'system/memory_recall', 'system/permission_denied', 'user'],
    capability: ['flag:--print', 'option:resume', 'query:interrupt'],
  },
}
const after: ToolSurface = {
  version: '2.1.282 (Claude Code) · SDK 0.3.288',
  offered: {
    command: ['clear', 'compact', 'context', 'goal', 'review', 'usage'],
    message: ['active_goal', 'assistant', 'result', 'system/init', 'system/permission_denied', 'user'],
    capability: ['flag:--print', 'option:resume', 'query:interrupt', 'query:readMcpResource'],
  },
}

describe('compareSurface', () => {
  it('says a blocked command the tool now offers may no longer need blocking (the /goal case)', () => {
    const findings = compareSurface(after, [goalBlock], before)
    expect(findings.filter((f) => f.sort === 'lifted')).toEqual([{ sort: 'lifted', kind: 'command', name: 'goal', limitation: goalBlock }])
  })

  it('says nothing of a limitation the adapter lifts by itself when the tool offers the name', () => {
    const followed = { ...goalBlock, followsOffer: true }
    expect(compareSurface(after, [followed], before).filter((f) => f.kind === 'command')).toEqual([])
  })

  it('reports what the tool offers that the baseline does not hold, per kind, in order', () => {
    const fresh = compareSurface(after, [], before).filter((f) => f.sort === 'new')
    expect(fresh).toEqual([
      { sort: 'new', kind: 'message', name: 'active_goal' },
      { sort: 'new', kind: 'capability', name: 'query:readMcpResource' },
    ])
  })

  it('compares no kind the baseline never recorded: the init command list is not news on every start', () => {
    expect(compareSurface(after, [], before).some((f) => f.kind === 'command')).toBe(false)
  })

  it('compares no kind the reading left out', () => {
    const messagesOnly: ToolSurface = { version: 'x', offered: { message: ['assistant'] } }
    expect(compareSurface(messagesOnly, [goalBlock], before).every((f) => f.kind === 'message')).toBe(true)
  })

  it('calls a limitation stale when the name it limits is no longer offered, and does not list it as gone too', () => {
    const findings = compareSurface(after, [dropped('system/memory_recall'), dropped('system/permission_denied')], before)
    expect(findings.filter((f) => f.sort === 'stale').map((f) => f.name)).toEqual(['system/memory_recall'])
    expect(findings.filter((f) => f.sort === 'gone')).toEqual([])
  })

  it('reports a name the baseline holds and the tool no longer offers as gone', () => {
    expect(compareSurface(after, [], before).filter((f) => f.sort === 'gone')).toEqual([
      { sort: 'gone', kind: 'message', name: 'system/memory_recall' },
    ])
  })

  it('finds nothing when the reading is the baseline', () => {
    const same: ToolSurface = { version: before.version, offered: before.offered }
    expect(compareSurface(same, [dropped('system/permission_denied')], before)).toEqual([])
  })

  it('keys findings by what they say, not their order, so a weekly run can tell an issue it already filed', () => {
    const findings = compareSurface(after, [goalBlock, dropped('system/memory_recall')], before)
    expect(findingsKey([...findings].reverse())).toBe(findingsKey(findings))
    expect(findingsKey(findings.slice(1))).not.toBe(findingsKey(findings))
  })
})

describe('surfaceReport', () => {
  const findings = compareSurface(after, [goalBlock, dropped('system/memory_recall')], before)
  const report = surfaceReport('claude', after, before, findings)

  it('names what was read and against which baseline', () => {
    expect(report).toContain('2.1.282 (Claude Code) · SDK 0.3.288')
    expect(report).toContain('recorded 2026-09-07')
  })

  it('carries each limitation with its measurement, so the issue says what to re-measure', () => {
    expect(report).toContain('### May no longer be limited (1)')
    expect(report).toContain('- command `goal`: blocked (measured 2026-09-07, SDK 0.3.231 and 0.3.263).')
    expect(report).toContain('### Limitations on names the tool no longer offers (1)')
  })

  it('lists the new names and leaves out the sections with nothing in them', () => {
    expect(report).toContain('### New since the baseline (2)\n')
    expect(report).toContain('- message `active_goal`')
    expect(report).not.toContain('No longer offered')
  })

  it("ends with how to close it: the adapter's limitations and a re-recorded baseline", () => {
    expect(report).toContain('`adapters/claude/surface.ts`')
    expect(report).toContain('pnpm drift:surface --record')
  })
})

describe('surfaceLogLines', () => {
  it('says a lifted or stale limitation in one host.log line, under the session', () => {
    const findings = compareSurface(after, [goalBlock, dropped('system/memory_recall')], before)
    expect(surfaceLogLines('claude', '0123456789ab', findings)).toEqual([
      '[claude] 01234567 the tool now offers command goal, which the adapter blocks (measured 2026-09-07, SDK 0.3.231 and 0.3.263); it may no longer need to',
      "[claude] 01234567 the tool no longer offers message system/memory_recall; the adapter's limitation on it (measured 2026-10-04, CLI 2.1.282 and SDK 0.3.263 (#58 survey)) is stale",
    ])
  })
})

describe('baselineSource', () => {
  it('writes one sorted name per line, quoted safely, under the kinds the reading carries', () => {
    const text = baselineSource({ version: "it's 1.0", offered: { message: ['b', 'a\\z'] } }, '2026-10-18')
    expect(text).toContain("  recorded: '2026-10-18',\n  version: 'it\\'s 1.0',\n")
    expect(text).toContain("    message: [\n      'a\\\\z',\n      'b',\n    ],\n")
    expect(text).not.toContain('command:')
  })
})
