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
    sessions: [
      { sessionId: 'here', name: 'Finish the composer', requests: 9, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1_120_000, rebuilds: 3 },
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
  it('shows the hit rate, what the input was made of, the rebuilds and the sessions that wrote most', () => {
    const { html, text } = render({ writes: true, countingSince: LONG_AGO, windows: [win(), win({ id: 'today', label: 'today' })] })
    expect(text).toContain('94% cache hit · last 5 h')
    expect(text).toContain('Read from cache 31.2M')
    expect(text).toContain('Written to cache 1.9M')
    expect(text).toContain('Uncached input 18k')
    expect(text).toContain('Rebuilds 6 of 412 requests')
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
      rebuilds: 0,
      inputTokens: 410_000,
      cacheReadTokens: 3_900_000,
      sessions: [{ sessionId: 'here', name: 'Optimize images', requests: 3, inputTokens: 260_000, cacheReadTokens: 1, cacheCreationTokens: 0, rebuilds: 0 }],
    })
    const { text } = render({ writes: false, countingSince: LONG_AGO, windows: [codex] }, 'Codex')
    expect(text).toContain('90% cache hit')
    expect(text).toContain('Written to cache not reported')
    expect(text).toContain('Codex reports cache reads only, not writes: the hit rate is cached input over all input.')
    expect(text).toContain('Most uncached input')
    expect(text).toContain('Optimize images 260k')
    expect(text).not.toContain('Rebuilds')
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
