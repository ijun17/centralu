import { describe, expect, it } from 'vitest'
import { toSnapshot as claudeSnapshot } from './claude/usage.js'
import { toSnapshot as codexSnapshot } from './codex/usage.js'

/**
 * Usage is a per-**account** thing, and the number and names of windows differ by tool.
 * This checks whether the adapter absorbs that difference and produces the same shape — the UI
 * itself does not count windows. Only subscription limits are covered: additional billing (credits) is not read.
 */

describe('claude usage', () => {
  // A shape pulled from a real response (max plan)
  const RAW = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      extra_usage: { is_enabled: false, used_credits: null }, // Out of scope — not read
      limits: [
        { kind: 'session', group: 'session', percent: 8, resets_at: '2026-08-17T00:40:00Z', scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 15, resets_at: '2026-08-21T07:00:00Z', scope: null },
        {
          kind: 'weekly_scoped', group: 'weekly', percent: 6, resets_at: '2026-08-21T07:00:00Z',
          scope: { model: { id: 'claude-opus-5', display_name: 'Opus' } },
        },
      ],
    },
  }

  it('carries windows into our own shape', () => {
    const s = claudeSnapshot(RAW)
    expect(s.plan).toBe('max')
    expect(s.windows.map((w) => [w.id, w.label, w.percent])).toEqual([
      ['session', '5 hours', 8],
      ['weekly_all', 'Weekly', 15],
      ['weekly_scoped', 'Weekly (per model)', 6],
    ])
    expect(s.windows[2]!.scope).toBe('Opus')
  })

  it('Claude has no daily window — this is left empty (the UI collapses that row)', () => {
    expect(claudeSnapshot(RAW).daily).toEqual([])
  })

  it('does not read additional-billing information (only subscription limits are covered)', () => {
    const s = claudeSnapshot(RAW)
    expect(JSON.stringify(s)).not.toContain('credit')
  })

  it('does not break even when the response is empty', () => {
    expect(claudeSnapshot(undefined)).toEqual({ plan: null, windows: [], daily: [] })
    expect(claudeSnapshot({ rate_limits: null })).toMatchObject({ windows: [] })
  })

  it('clamps the percentage to 0-100', () => {
    const s = claudeSnapshot({ rate_limits: { limits: [{ kind: 'session', percent: 140 }] } })
    expect(s.windows[0]!.percent).toBe(100)
  })
})

describe('codex usage', () => {
  // A shape pulled from a real response (pro plan)
  const RATE = {
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1787198872 },
      secondary: null,
      credits: { hasCredits: false, balance: '0' }, // Out of scope
    },
  }
  const USAGE = {
    summary: { lifetimeTokens: 17760550131 },
    dailyUsageBuckets: [
      { startDate: '2026-08-14', tokens: 201485509 },
      { startDate: '2026-08-15', tokens: 115640 },
      { startDate: '2026-08-16', tokens: 9005155 },
    ],
  }

  it('builds a human-readable name from the window length (minutes)', () => {
    const s = codexSnapshot(RATE, USAGE)
    expect(s.plan).toBe('pro')
    expect(s.windows).toHaveLength(1) // Not included when secondary is null
    expect(s.windows[0]).toMatchObject({ id: 'primary', label: '1w', percent: 22 })
    // Unix time in seconds -> ISO
    expect(s.windows[0]!.resetsAt).toMatch(/^\d{4}-/)
  })

  it('takes daily tokens as-is (unlike Claude, there is no aggregation needed)', () => {
    const s = codexSnapshot(RATE, USAGE)
    // The tool's own name (startDate) ends at the adapter — only our own shape (date) goes out
    expect(s.daily).toEqual([
      { date: '2026-08-14', tokens: 201485509 },
      { date: '2026-08-15', tokens: 115640 },
      { date: '2026-08-16', tokens: 9005155 },
    ])
  })

  it('keeps the limit even when daily data cannot be fetched', () => {
    const s = codexSnapshot(RATE, null)
    expect(s.windows).toHaveLength(1)
    expect(s.daily).toEqual([])
  })

  it('does not break even when the response is empty', () => {
    expect(codexSnapshot(undefined, undefined)).toEqual({ plan: null, windows: [], daily: [] })
  })
})
