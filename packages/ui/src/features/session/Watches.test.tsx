/**
 * The watches a session keeps, in its header (#1324, docs/plans/mailbox.md §18.8): a badge only while there is one, rows in the
 * person's words, Cancel through the host, and nothing at all against a host that has no such method.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import type { WatchView } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { resetStore } from '../../store/store.test-helpers.js'
import { watchLine, WatchesCapsule, WatchRow } from './Watches.jsx'

beforeEach(() => {
  resetStore()
  useStore.setState({ watches: {} })
})

// Local times, as the rows write them
const now = new Date(2026, 10, 13, 9, 0).getTime()
const today = (h: number, m: number) => new Date(2026, 10, 13, h, m).getTime()
const tomorrow = (h: number, m: number) => new Date(2026, 10, 14, h, m).getTime()

const watch = (over: Partial<WatchView>): WatchView => ({ id: 'w1', source: 'time', what: '', at: null, everyMinutes: null, until: today(16, 30), note: '', createdAt: now, ...over })

function attached() {
  const platform = new MockPlatform()
  useStore.setState({ platform })
  platform.agents.subscribe((e) => useStore.getState().dispatchEvent(e))
  return platform
}

describe('the rows', () => {
  it('say what each watch waits for, with the session’s name and local times', () => {
    expect(watchLine(watch({ source: 'session', what: 'Parser' }), now)).toBe('Until Parser ends its turn, asks or stops · until 16:30')
    expect(watchLine(watch({ at: today(16, 30) }), now)).toBe('At 16:30')
    expect(watchLine(watch({ at: tomorrow(8, 5) }), now)).toBe('At 08:05 tomorrow')
    expect(watchLine(watch({ at: today(9, 30), everyMinutes: 30, until: tomorrow(14, 5) }), now)).toBe('Every 30 minutes · until tomorrow 14:05')
    expect(watchLine(watch({ everyMinutes: 60, until: new Date(2026, 10, 20, 14, 5).getTime() }), now)).toBe('Every 60 minutes · until Nov 20 14:05')
    expect(watchLine(watch({ source: 'pr', what: '#123' }), now)).toBe('Until the checks on #123 finish')
    expect(watchLine(watch({ source: 'other', what: 'a newer host’s watch' }), now)).toBe('a newer host’s watch')
  })

  it('put the note under the line, and a leaving row takes no press', () => {
    const html = renderToStaticMarkup(<WatchRow sessionId="s1" watch={watch({ at: today(16, 30), note: 'check the deploy' })} now={now} />)
    expect(html).toContain('At 16:30')
    expect(html).toContain('check the deploy')
    expect(html).toContain('Cancel')
    const leaving = renderToStaticMarkup(<WatchRow sessionId="s1" watch={watch({})} now={now} gone />)
    expect(leaving).toMatch(/class="[^"]*cc-fade-out pointer-events-none/)
    expect(leaving).toContain('inert=""')
  })
})

describe('the badge', () => {
  it('is not drawn while the session keeps none, and counts the ones it keeps', () => {
    expect(renderToStaticMarkup(<WatchesCapsule sessionId="s1" rows={undefined} />)).toBe('')
    expect(renderToStaticMarkup(<WatchesCapsule sessionId="s1" rows={[]} />)).toBe('')
    const html = renderToStaticMarkup(<WatchesCapsule sessionId="s1" rows={[watch({ id: 'a' }), watch({ id: 'b' })]} />)
    expect(html).toContain('data-count="2"')
    expect(html).toContain('aria-label="2 watches set to wake this session"')
  })

  it('follows the host: a watch set shows, Cancel goes to the host and the row leaves the list', async () => {
    const platform = attached()
    await useStore.getState().loadWatches('s1')
    expect(useStore.getState().watches.s1).toEqual([])
    const id = platform.seedWatch('s1', { source: 'session', what: 'Parser', at: null, everyMinutes: null, until: today(16, 30), note: '' })
    platform.seedWatch('s1', { source: 'time', what: '', at: today(12, 0), everyMinutes: null, until: today(12, 0), note: '' })
    await vi.waitFor(() => expect(useStore.getState().watches.s1).toHaveLength(2))

    expect(await useStore.getState().cancelWatch('s1', id)).toBe(true)
    expect(platform.mockMail.calls).toContain(`cancelWatch:${id}`)
    expect(useStore.getState().watches.s1?.map((w) => w.id)).not.toContain(id)
    expect(renderToStaticMarkup(<WatchesCapsule sessionId="s1" rows={useStore.getState().watches.s1} />)).toContain('data-count="1"')
  })

  it('shows nothing, and says nothing, against an older host that has no watches', async () => {
    const platform = attached()
    platform.mockMail.knowsWatches = false
    await useStore.getState().loadWatches('s1')
    expect(useStore.getState().watches.s1).toBeUndefined()
    expect(useStore.getState().toast).toBeNull()
    expect(renderToStaticMarkup(<WatchesCapsule sessionId="s1" rows={useStore.getState().watches.s1} />)).toBe('')
  })
})
