import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@cc/core'
import type { AppState } from '../../../store/store.js'

/*
 * The Stop button while the tool has not confirmed the stop (#1060). renderToStaticMarkup reads a zustand store's
 * initial state, so `useStore` is replaced by one that reads `state` (as in RowApproval.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { ActivityRow } = await import('./ActivityRow.jsx')

beforeEach(() => {
  state = {}
})

const TURN = 1_000
function render(stopping: AppState['stopping'] = {}) {
  state = {
    sessions: { s1: { id: 's1', state: 'working', backgroundTasks: [] } as unknown as SessionSummary },
    workingSince: { s1: TURN },
    stopping,
  }
  const html = renderToStaticMarkup(<ActivityRow sessionId="s1" activity={null} />)
  const button = /<button[^>]*data-testid="activity-interrupt"[^>]*>([^<]*)<\/button>/.exec(html)
  return { html, tag: button?.[0] ?? '', label: button?.[1] ?? '' }
}

describe('ActivityRow Stop', () => {
  it('is Stop before it is pressed', () => {
    const { tag, label } = render()
    expect(label).toBe('Stop')
    expect(tag).not.toMatch(/ disabled=""/)
  })

  it('says Stopping… from the click until the session leaves working', () => {
    const { tag, label } = render({ s1: { turn: TURN } })
    expect(label).toBe('Stopping…')
    expect(tag).toMatch(/ disabled=""/)
    expect(tag).toContain('aria-busy="true"')
  })

  it('is Stop again, with the notice beside it, when the tool says the stop has not taken effect', () => {
    const text = 'Claude Code has not confirmed the stop after 10 s. The turn is still running.'
    const { html, tag, label } = render({ s1: { turn: TURN, failed: text } })
    expect(label).toBe('Stop')
    expect(tag).not.toMatch(/ disabled=""/)
    expect(html).toContain('data-testid="interrupt-unconfirmed"')
    expect(html).toContain(text)
  })

  it('a Stop pressed in an earlier turn is not this turn’s', () => {
    expect(render({ s1: { turn: TURN - 500 } }).label).toBe('Stop')
  })
})
