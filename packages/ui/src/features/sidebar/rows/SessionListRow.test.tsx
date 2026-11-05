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

  // #1416: a child started on another machine stands in that machine's project; its row names no machine, the project does
  it('draws no machine tag on the row itself, and no pointer to what a session handed to another machine', () => {
    const child = session({ id: 'm1.c1', machine: 'm1', askedBy: 's1' })
    state = {
      machines: { m1: { id: 'm1', name: 'Windows PC' } },
      sessions: { s1: session(), 'm1.c1': child },
    } as unknown as Partial<AppState>
    expect(render(child, false)).not.toContain('session-machine-')
    expect(render(session(), false)).not.toMatch(/handed-off-| on Windows PC/)
  })

  // Owner, 2026-11-05: auto is the default now, so the preset of a session a linked computer started is noise on the row (the header still says it)
  it('shows no preset tag on the row, whichever preset a linked computer started it under', () => {
    for (const permissionPreset of ['auto', 'normal'] as const) {
      expect(render(session({ permissionPreset, startedFromHub: true }), false)).not.toContain('session-preset-')
    }
  })

  it('names a pull request by its number alone, with its state and address in the tooltip', () => {
    const html = render(session({ pr: { number: 1998, state: 'open', url: 'https://example.test/pull/1998' } }), false)
    expect(html).toMatch(/data-testid="pr-badge-s1"[^>]*title="Pull request #1998 — open\nhttps:\/\/example\.test\/pull\/1998"[^>]*>#1998</)
    expect(html).not.toContain('PR #')
    expect(render(session({ pr: { number: 7, state: 'closed', url: 'u' } }), false)).toMatch(/data-testid="pr-badge-s1"[^>]*>#7 ✕</)
  })

  it('draws background work as a dot on the tool mark, not as a chip, and says it in the label of the mark', () => {
    const task = { id: 'b1', kind: 'shell', description: 'sleep 99', stoppable: true, status: 'running' }
    const html = render(session({ backgroundTasks: [task, { ...task, id: 'b2', description: 'tail -f log' }] as SessionSummary['backgroundTasks'] }), false)
    expect(html).not.toMatch(/>\d+ bg</)
    expect(html).toMatch(/data-testid="background-mark-s1"/)
    expect(html).toContain(
      [' · 2 background tasks running (keeps the session awake)', '· sleep 99', '· tail -f log" data-testid="tool-mark-'].join('\n'),
    )
    const quiet = render(session(), false)
    expect(quiet).not.toContain('background-mark-')
    expect(quiet).not.toContain('background task')
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
