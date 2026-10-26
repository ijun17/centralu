import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/store.js'

/*
 * The context gauge in the composer footer (#1572): an estimate is drawn like any reading, with no "≈", and the bar carries no
 * mark where the tool compacts. renderToStaticMarkup reads a zustand store's initial state, so `useStore` is replaced by one that
 * reads `state` (as in SessionListRow.test.tsx); the settings menu is not what is under test.
 */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})
vi.mock('./SessionSettings.jsx', () => ({ SessionSettings: () => null }))

const { ComposerFooter } = await import('./ComposerFooter.jsx')

beforeEach(() => {
  state = {}
})

function render(context: Record<string, unknown> | undefined): string {
  state = { sessions: { s1: { id: 's1', tool: 'claude', live: true, context } } } as unknown as Partial<AppState>
  return renderToStaticMarkup(<ComposerFooter sessionId="s1" />)
}

const text = (html: string) => html.replace(/<[^>]*>/g, '')

describe('the context gauge', () => {
  it('draws an estimate without ≈, and the tooltip still says it is estimated', () => {
    const html = render({ used: 8800, window: 1000000, exactness: 'estimate' })
    expect(text(html)).toContain('Context 1%')
    expect(html).not.toContain('≈')
    expect(html).toContain('estimated until the next turn ends')
  })

  it('keeps ≤ for a capped reading, an estimate or not', () => {
    expect(text(render({ used: 21000, window: 153000, exactness: 'estimate', capped: true }))).toContain('Context ≤14%')
    expect(render({ used: 21000, window: 153000, exactness: 'estimate', capped: true })).not.toContain('≈')
  })

  it.each([300000, 600000])('draws no compaction mark when compactAt is %i', (tokens) => {
    const html = render({ used: 304000, window: 1000000, exactness: 'exact', compactAt: tokens })
    expect(html).not.toContain('context-gauge-compact-mark')
    expect(html).toContain('data-testid="context-gauge-fill"')
  })

  it('still names the compaction point in the tooltip and warns near it', () => {
    const html = render({ used: 520000, window: 1000000, exactness: 'exact', compactAt: 600000 })
    expect(html).toContain('compacts at 600k tokens (60%)')
    expect(html).toContain('title="Context 520k / 1M tokens · compacts at 600k tokens (60%)"')
    expect(html).toContain('bg-ink"')
    expect(html).not.toContain('context-gauge-compact-mark')
  })
})
