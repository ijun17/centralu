import { describe, expect, it } from 'vitest'
import { toSnapshot as claudeSnapshot } from './claude/usage.js'
import { toSnapshot as codexSnapshot } from './codex/usage.js'

/**
 * 사용량은 **계정** 단위이고, 도구마다 창의 개수·이름이 다르다.
 * 어댑터가 그 차이를 흡수해 같은 모양으로 내놓는지 본다 — UI는 창을 세지 않는다.
 * 구독 한도만 다룬다: 추가 결제(크레딧)는 읽지 않는다.
 */

describe('claude 사용량', () => {
  // 실제 응답에서 뽑은 모양 (max 플랜)
  const RAW = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      extra_usage: { is_enabled: false, used_credits: null }, // 범위 밖 — 읽지 않는다
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

  it('창을 우리 모양으로 옮긴다', () => {
    const s = claudeSnapshot(RAW)
    expect(s.plan).toBe('max')
    expect(s.windows.map((w) => [w.id, w.label, w.percent])).toEqual([
      ['session', '5시간', 8],
      ['weekly_all', '주간', 15],
      ['weekly_scoped', '주간 (모델별)', 6],
    ])
    expect(s.windows[2]!.scope).toBe('Opus')
  })

  it('Claude에는 일간 창이 없다 — 비운다 (UI가 그 줄을 접는다)', () => {
    expect(claudeSnapshot(RAW).daily).toEqual([])
  })

  it('추가 결제 정보는 읽지 않는다 (구독 한도만 다룬다)', () => {
    const s = claudeSnapshot(RAW)
    expect(JSON.stringify(s)).not.toContain('credit')
  })

  it('응답이 비어도 무너지지 않는다', () => {
    expect(claudeSnapshot(undefined)).toEqual({ plan: null, windows: [], daily: [] })
    expect(claudeSnapshot({ rate_limits: null })).toMatchObject({ windows: [] })
  })

  it('퍼센트는 0~100으로 자른다', () => {
    const s = claudeSnapshot({ rate_limits: { limits: [{ kind: 'session', percent: 140 }] } })
    expect(s.windows[0]!.percent).toBe(100)
  })
})

describe('codex 사용량', () => {
  // 실제 응답에서 뽑은 모양 (pro 플랜)
  const RATE = {
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1787198872 },
      secondary: null,
      credits: { hasCredits: false, balance: '0' }, // 범위 밖
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

  it('창 길이(분)로 사람이 아는 이름을 만든다', () => {
    const s = codexSnapshot(RATE, USAGE)
    expect(s.plan).toBe('pro')
    expect(s.windows).toHaveLength(1) // secondary가 null이면 넣지 않는다
    expect(s.windows[0]).toMatchObject({ id: 'primary', label: '1주', percent: 22 })
    // 초 단위 유닉스 시각 → ISO
    expect(s.windows[0]!.resetsAt).toMatch(/^\d{4}-/)
  })

  it('일별 토큰을 그대로 받는다 (Claude와 달리 집계할 필요가 없다)', () => {
    const s = codexSnapshot(RATE, USAGE)
    // 도구 고유 이름(startDate)은 어댑터에서 끝난다 — 밖으로는 우리 모양(date)만 나간다
    expect(s.daily).toEqual([
      { date: '2026-08-14', tokens: 201485509 },
      { date: '2026-08-15', tokens: 115640 },
      { date: '2026-08-16', tokens: 9005155 },
    ])
  })

  it('일별을 못 받아도 한도는 살린다', () => {
    const s = codexSnapshot(RATE, null)
    expect(s.windows).toHaveLength(1)
    expect(s.daily).toEqual([])
  })

  it('응답이 비어도 무너지지 않는다', () => {
    expect(codexSnapshot(undefined, undefined)).toEqual({ plan: null, windows: [], daily: [] })
  })
})
