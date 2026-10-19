import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@cc/core'
import type { ExternalAppInfo } from '@cc/protocol'
import type { AppState } from '../../../store/store.js'
import { buildCatalog } from '../../../store/app-catalog.js'

/*
 * An app row drawn from a seeded store. renderToStaticMarkup reads a zustand store's initial state, so `useStore` is
 * replaced by one that reads `state` (as in SessionListRow.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { AppRow } = await import('./AppRow.jsx')

beforeEach(() => {
  state = {}
})

function app(over: Partial<ExternalAppInfo> = {}) {
  const info = { appId: 'x', projectId: null, name: 'X', status: 'stopped', ...over } as ExternalAppInfo
  return buildCatalog([info]).external[0]!
}

const waiting = (over: Partial<SessionSummary> = {}) =>
  ({ id: 's1', name: 'builder', tool: 'claude', state: 'waiting_approval', live: true, pendingQuestions: [], appId: 'x', projectId: null, ...over }) as unknown as SessionSummary

const render = (a: ReturnType<typeof app>, sessions: SessionSummary[]) =>
  renderToStaticMarkup(<AppRow app={a} sessions={sessions} folded={false} onFold={() => {}} />)

describe('an app row says "asks you" for its own sessions only (#1143 U6)', () => {
  it("does not take a linked machine's session of the same app id for this computer's app", () => {
    // m1's builder of its user app `x` waits on an approval; this computer's `x` row is given none of the sessions
    state = { sessions: { s1: waiting({ machine: 'm1' } as Partial<SessionSummary>) } }
    expect(render(app(), [])).not.toContain('asks you')
  })

  it("lights the machine's row for the session of that machine", () => {
    const m1 = app({ machine: 'm1' })
    state = { sessions: { s1: waiting({ machine: 'm1' } as Partial<SessionSummary>) } }
    const html = render(m1, [waiting({ machine: 'm1' } as Partial<SessionSummary>)])
    expect(html).toContain('asks you')
  })

  it('lights a project app for its waiting session, and not for a finished one', () => {
    const p = app({ projectId: 'p1' })
    expect(render(p, [waiting({ projectId: 'p1' })])).toContain('asks you')
    expect(render(p, [waiting({ projectId: 'p1', state: 'idle' })])).not.toContain('asks you')
  })
})
