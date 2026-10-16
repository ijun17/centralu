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

function render(s: SessionSummary, inApp: boolean, nested = false) {
  return renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <SessionListRow
        row={{ s, nested, children: [], folded: false }}
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

  it('keeps each list its own test id and indentation', () => {
    expect(render(session(), false)).toContain('data-testid="session-row-s1"')
    expect(render(session(), true)).toContain('data-testid="app-session-row-s1"')
    expect(render(session(), false)).toContain('data-level="1"')
    expect(render(session(), true)).toContain('data-level="2"')
    expect(render(session(), true, true)).toContain('data-level="3"')
  })
})
