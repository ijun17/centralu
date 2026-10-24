import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CacheStats, CacheWindowStats } from '@cc/protocol'
import { CacheSection } from './CacheSection.jsx'

const NOW = Date.now()
const LONG_AGO = new Date(NOW - 30 * 3600_000).toISOString()

function win(over: Partial<CacheWindowStats> = {}): CacheWindowStats {
  return {
    id: '5h',
    label: 'last 5 h',
    since: new Date(NOW - 5 * 3600_000).toISOString(),
    requests: 412,
    inputTokens: 18_400,
    cacheReadTokens: 31_200_000,
    cacheCreationTokens: 1_940_000,
    rebuilds: 6,
    rebuildCauses: { expired: 3, model_change: 1, compaction: 1, unknown: 1 },
    expiredIdleMs: { min: 64 * 60_000, max: 64 * 60_000 },
    sessions: [
      { sessionId: 'here', name: 'Finish the composer', requests: 9, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1_120_000, rebuilds: 3, rebuildCauses: { expired: 2, model_change: 1 } },
      { sessionId: 'gone', name: '', requests: 2, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 540_000, rebuilds: 1 },
    ],
    ...over,
  }
}

const render = (cache: CacheStats, toolLabel = 'Claude Code') => {
  const html = renderToStaticMarkup(
    <CacheSection cache={cache} toolLabel={toolLabel} canOpen={(id) => id === 'here'} onOpen={() => {}} />,
  )
  // Text alone, so assertions read as what a person sees
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') }
}

describe('CacheSection', () => {
  it('shows 99.8 percent rather than a perfect hit rate in the dropdown (#587)', () => {
    const { text } = render({ writes: false, countingSince: LONG_AGO, windows: [win({ inputTokens: 70_689, cacheReadTokens: 35_617_437, cacheCreationTokens: 0 })] })
    expect(text).toContain('99.8% cache hit')
    expect(text).not.toContain('100%')
  })

  it('shows the hit rate, what the input was made of, the rebuilds and the sessions that wrote most', () => {
    const { html, text } = render({ writes: true, countingSince: LONG_AGO, windows: [win(), win({ id: 'today', label: 'today' })] })
    expect(text).toContain('94.1% cache hit · last 5 h')
    expect(text).toContain('Read from cache 31.2M')
    expect(text).toContain('Written to cache 1.9M')
    expect(text).toContain('Uncached input 18.4k')
    expect(text).toContain('Rebuilds 6 of 412 requests')
    expect(text).toContain('6 rebuilds: 3 cache expired (idle 64 min) · 1 model change · 1 compaction · 1 unknown')
    // Each session that rebuilt says why, under its name
    expect(text).toContain('Finish the composer 1.1M · 3 rebuilds 2 cache expired · 1 model change')
    expect(text).toContain('Most cache writes')
    expect(text).toContain('Finish the composer 1.1M · 3 rebuilds')
    // A session this screen has opens; one that is gone is named so and is not a button
    expect(html).toMatch(/<button[^>]*data-testid="usage-cache-session-here"/)
    expect(html).toMatch(/<span[^>]*data-testid="usage-cache-session-gone"/)
    expect(text).toContain('Deleted session 540k · 1 rebuild')
    // The two windows behind one switch, the first one pressed
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="usage-cache-window-5h"/)
    expect(text).not.toContain('reports cache reads only')
  })

  it('says plainly that a tool reports reads only, and ranks its sessions by uncached input', () => {
    const codex = win({
      cacheCreationTokens: 0,
      rebuilds: 1,
      rebuildCauses: { thread_restart: 1 },
      expiredIdleMs: undefined,
      inputTokens: 410_000,
      cacheReadTokens: 3_900_000,
      sessions: [{ sessionId: 'here', name: 'Optimize images', requests: 3, inputTokens: 260_000, cacheReadTokens: 1, cacheCreationTokens: 0, rebuilds: 0 }],
    })
    const { text } = render({ writes: false, countingSince: LONG_AGO, windows: [codex] }, 'Codex')
    expect(text).toContain('90.5% cache hit')
    expect(text).toContain('Written to cache not reported')
    expect(text).toContain('Codex reports cache reads only, not writes: the hit rate is cached input over all input.')
    expect(text).toContain('Most uncached input')
    expect(text).toContain('Optimize images 260k')
    // A request that read less than half its input from cache counts as a rebuild for a reads-only tool
    expect(text).toContain('Rebuilds 1 of 412 requests')
    expect(text).toContain('1 rebuild: 1 thread restart')
  })

  it('says there were no requests rather than drawing 0%', () => {
    const empty = win({ requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rebuilds: 0, sessions: [] })
    const { text } = render({ writes: true, countingSince: LONG_AGO, windows: [empty] })
    expect(text).toContain('No model requests in the last 5 h')
    expect(text).not.toContain('%')
  })

  it('names the start, and says earlier requests are unknown, when the host began counting inside the window', () => {
    const started = new Date(NOW - 2 * 3600_000)
    const hhmm = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`
    const { text } = render({ writes: true, countingSince: started.toISOString(), windows: [win()] })
    expect(text).toContain(`cache hit · since ${hhmm}`)
    expect(text).toContain('Counted by the host since it started; earlier requests are not known.')
  })
})

describe('CacheSection: rebuild tokens and the write share of the cache cost (#1492)', () => {
  const costed = (over: Partial<CacheWindowStats> = {}) =>
    win({
      rebuildTokens: 1_020_000,
      cacheReadCost: 3_120_000,
      cacheWriteCost: 2_380_000,
      sessions: [{ sessionId: 'here', name: 'Finish the composer', requests: 9, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1_120_000, rebuilds: 3, rebuildTokens: 600_000 }],
      ...over,
    })

  it('says what the rebuilds wrote beside their count, per window and per session, and the writes’ share of the cost beside the hit rate', () => {
    const { text } = render({ writes: true, countingSince: LONG_AGO, windows: [costed()] })
    expect(text).toContain('94.1% cache hit · last 5 h')
    expect(text).toContain('writes: 43.3% of cache cost')
    expect(text).toContain('6 rebuilds · 1M written: 3 cache expired (idle 64 min)')
    expect(text).toContain('Finish the composer 1.1M · 3 rebuilds (600k)')
  })

  it('names the uncached input for a tool that reports reads only, which stands in for writes', () => {
    const { text } = render({ writes: false, countingSince: LONG_AGO, windows: [costed({ cacheCreationTokens: 0 })] }, 'Codex')
    expect(text).toContain('uncached input: 43.3% of cache cost')
    expect(text).toContain('6 rebuilds · 1M uncached: ')
  })

  it('shows neither from a host that does not say, and not the share with nothing to weigh', () => {
    const { text } = render({ writes: true, countingSince: LONG_AGO, windows: [win()] })
    expect(text).not.toContain('of cache cost')
    expect(text).not.toContain('written:')
    const none = render({ writes: true, countingSince: LONG_AGO, windows: [costed({ cacheReadCost: 0, cacheWriteCost: 0 })] })
    expect(none.text).not.toContain('of cache cost')
  })
})

describe('CacheSection from a host that predates rebuild causes', () => {
  it('shows the rebuild count without a breakdown', () => {
    const { rebuildCauses: _c, expiredIdleMs: _i, ...old } = win()
    const { text } = render({ writes: true, countingSince: LONG_AGO, windows: [{ ...old, sessions: [] }] })
    expect(text).toContain('Rebuilds 6 of 412 requests')
    expect(text).not.toContain('6 rebuilds:')
  })
})
