import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AwayNote } from './AwayNote.jsx'

// #1398: the note under an away machine's headline in Settings → Machines: when it was last connected, when the next try is due, and ssh's own line as details
const base = { status: 'away' as const, error: 'ssh could not reach jungi: ssh: connect to host jungi.tail3d9122.ts.net port 22: Operation timed out' }

describe('the note of a machine that is away', () => {
  it('says when it was last connected and when the next attempt is due, and keeps the ssh line as details', () => {
    const html = renderToStaticMarkup(<AwayNote m={{ ...base, lastConnectedAt: Date.now() - 39 * 60_000, nextAttemptAt: Date.now() + 2.5 * 60_000 }} testId="away" />)
    expect(html).toContain('Last connected 39m ago')
    expect(html).toMatch(/trying again in [23] min/)
    expect(html).toContain('Operation timed out')
    expect(html).toContain('font-mono')
  })

  it('says it was never connected when it was not, and nothing about a next attempt when none is due', () => {
    const html = renderToStaticMarkup(<AwayNote m={{ ...base, lastConnectedAt: null, nextAttemptAt: null }} testId="away" />)
    expect(html).toContain('Not connected yet')
    expect(html).not.toContain('trying again')
  })

  it('is nothing for a machine in any other state', () => {
    for (const status of ['connected', 'unreachable', 'connecting', 'refused'] as const) {
      expect(renderToStaticMarkup(<AwayNote m={{ ...base, status, lastConnectedAt: 1, nextAttemptAt: null }} testId="away" />)).toBe('')
    }
  })
})
