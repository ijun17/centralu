import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import type { AppState } from '../../../store/store.js'
import { PlatformProvider } from '../../../app/PlatformProvider.jsx'

/*
 * The shared session row drawn from a seeded session. renderToStaticMarkup reads a zustand store's initial state, so
 * `useStore` is replaced by one that reads `state` (as in RowApproval.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { SessionListRow } = await import('./SessionListRow.jsx')

const platform = { capabilities: { shortcutKeys: { mod: '⌘', alt: '⌥' } } } as unknown as Platform

beforeEach(() => {
  state = {}
})

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    name: 'Fix login',
    tool: 'claude',
    state: 'idle',
    live: true,
    lastSeq: 0,
    lastReadSeq: 0,
    pendingQuestions: [],
    backgroundTasks: [],
    ...over,
  } as unknown as SessionSummary
}

function render(s: SessionSummary, inApp: boolean, nested = false, depth = nested ? 1 : 0) {
  return renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <SessionListRow
        row={{ s, nested, depth, children: [], folded: false }}
        projectId="p1"
        inApp={inApp}
        onReorder={() => {}}
        focusedSessionId={null}
        renaming={null}
        setRenaming={() => {}}
        sessionMenu={null}
        setSessionMenu={() => {}}
        setHandingOff={() => {}}
        setConfirming={() => {}}
      />
    </PlatformProvider>,
  )
}

describe('SessionListRow', () => {
  it('tells a merged session in an app list what the badge means, as it does in the project list', () => {
    const merged = session({ merged: true })
    for (const inApp of [false, true]) {
      const html = render(merged, inApp)
      expect(html).toMatch(
        /<span[^>]*data-testid="merged-badge-s1"[^>]*title="Branch merged into the trunk — safe to clean up from the delete dialog"/,
      )
    }
  })

  // #1416: a child started on another machine stands in that machine's project; its parent's row points there
  describe('what the session handed to another machine', () => {
    const child = (id: string, over: Partial<SessionSummary> = {}) => session({ id, machine: 'm1', askedBy: 's1', ...over })
    const seed = (...children: SessionSummary[]) => {
      state = {
        machines: { m1: { id: 'm1', name: 'Windows PC' }, m2: { id: 'm2', name: 'Mac mini' } },
        sessions: Object.fromEntries([session(), ...children].map((x) => [x.id, x])),
      } as unknown as Partial<AppState>
    }

    it('says how many are on which machine, quietly, with no dot while none of them needs the person', () => {
      seed(child('m1.a'), child('m1.b'))
      const html = render(session(), false)
      expect(html).toMatch(/data-testid="handed-off-s1-m1"[^>]*>(?:<span[^>]*>)?2 on Windows PC</)
      expect(html).not.toContain('handed-off-s1-m1-attention')
      expect(html).not.toMatch(/data-testid="handed-off-s1-m1"[^>]*data-attention/)
    })

    it('lights the pointer when one of them waits or has errored, so a stopped child is seen from its parent', () => {
      for (const state of ['waiting_approval', 'error'] as const) {
        seed(child('m1.a'), child('m1.b', { state }))
        const html = render(session(), false)
        expect(html).toMatch(/data-testid="handed-off-s1-m1"[^>]*data-attention="alert"/)
        expect(html).toContain('handed-off-s1-m1-attention')
        expect(html).toMatch(/aria-label="2 on Windows PC, one needs you"/)
      }
    })

    it('has one pointer per machine, and none when the children run on its own machine or it started nothing', () => {
      seed(child('m1.a'), child('m2.a', { machine: 'm2' }), child('l1', { machine: null }))
      const html = render(session(), false)
      expect(html).toMatch(/data-testid="handed-off-s1-m1"[^>]*>(?:<span[^>]*>)?1 on Windows PC</)
      expect(html).toMatch(/data-testid="handed-off-s1-m2"[^>]*>(?:<span[^>]*>)?1 on Mac mini</)
      expect(html).not.toContain('handed-off-s1-null')
      seed(child('l1', { machine: null }))
      expect(render(session(), false)).not.toContain('handed-off-')
    })

    it('draws no machine tag on the row itself: the project it stands in names the machine', () => {
      seed()
      expect(render(session({ id: 'm1.c1', machine: 'm1' }), false)).not.toContain('session-machine-')
    })
  })

  // #1273: a child a linked computer's session started runs under the preset it carried; its row says which
  it('shows the preset of a session a linked computer started, and of no other', () => {
    expect(render(session({ permissionPreset: 'auto', startedFromHub: true }), false)).toMatch(/data-testid="session-preset-s1"[^>]*>auto</)
    expect(render(session({ permissionPreset: 'normal', startedFromHub: true }), false)).toMatch(/data-testid="session-preset-s1"[^>]*>normal</)
    expect(render(session({ permissionPreset: 'auto' }), false)).not.toContain('session-preset-')
  })

  it('keeps each list its own test id and indentation', () => {
    expect(render(session(), false)).toContain('data-testid="session-row-s1"')
    expect(render(session(), true)).toContain('data-testid="app-session-row-s1"')
    expect(render(session(), false)).toContain('data-level="1"')
    expect(render(session(), true)).toContain('data-level="2"')
    expect(render(session(), true, true)).toContain('data-level="3"')
    // A child's own child stands one step further in (#862), and nothing goes past the deepest level drawn
    expect(render(session(), false, true, 2)).toContain('data-level="3"')
    expect(render(session(), true, true, 9)).toContain('data-level="5"')
  })
})
