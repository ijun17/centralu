/**
 * What an event of one session draws again in the sidebar: that session's row, and nothing in another project. Drawing
 * every row of every project for every event of every session, a streamed reply's every piece included, was measured as
 * most of what the window allocated while sessions worked out of view (perf:memory --steps background).
 *
 * Real React, the real store and the real list (`ProjectSessionList`), so a function it made anew on each draw and
 * passed to its rows would fail this. The node test run has no DOM: the row's element (`SessionRow`) is replaced by one
 * that counts and draws nothing, and the list's one element is drawn into a stand-in that only takes it (as in
 * useChatScroll.test.ts).
 */
import { act, createElement, Fragment, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol/client'
import { sessionFromInfo } from '../../../store/sessionList.js'
import { useCounts, useSessionsOf } from '../../../store/selectors.js'
import { useStore } from '../../../store/store.js'
import { resetStore, sessionInfo } from '../../../store/store.test-helpers.js'
import { groupProjectAppSessions } from '../tree.js'

const drawn: string[] = []
vi.mock('./SessionRow.jsx', () => ({
  SessionRow: ({ id }: { id: string }) => {
    drawn.push(id)
    return null
  },
}))
const { ProjectSessionList } = await import('../project/ProjectSessionList.jsx')

const keep = () => {}
const blocks: string[] = []

/** A project's list as its block draws it (ProjectBlock), with the functions the block passes staying the same */
function Block({ projectId }: { projectId: string }) {
  const sessions = useSessionsOf(projectId)
  blocks.push(projectId)
  const groupedSessions = useMemo(() => groupProjectAppSessions(sessions, []), [sessions])
  return createElement(ProjectSessionList, {
    projectId,
    sessions,
    groupedSessions,
    renaming: null,
    setRenaming: keep,
    sessionMenu: null,
    setSessionMenu: keep,
    setHandingOff: keep,
    setConfirming: keep,
  })
}

/** An element that takes what React puts in it and draws nothing */
function standIn(tag: string, ownerDocument: object): Element {
  const name = tag.toUpperCase()
  return {
    nodeType: 1, tagName: name, nodeName: name, namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument, style: {},
    textContent: '', appendChild() {}, insertBefore() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
  } as unknown as Element
}

let root: Root
const initial = useStore.getState()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const doc = {
    addEventListener() {}, removeEventListener() {}, defaultView: { document: { activeElement: null }, HTMLIFrameElement: class {} },
    createElement: (tag: string) => standIn(tag, doc),
  }
  root = createRoot(standIn('div', doc))
  resetStore()
  const info = [sessionInfo('a1'), sessionInfo('a2'), sessionInfo('a3', { parentSessionId: 'a1' }), sessionInfo('b1', { projectId: 'p2' })]
  useStore.setState({ sessions: Object.fromEntries(info.map((i) => [i.id, sessionFromInfo(i)])) })
  act(() => root.render(createElement(Fragment, null, createElement(Block, { projectId: 'p1' }), createElement(Block, { projectId: 'p2' }))))
  drawn.length = 0
  blocks.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  useStore.setState(initial, true)
})

const dispatch = (e: NormalizedEvent) => act(() => useStore.getState().dispatchEvent(e))

describe('an event of one session (perf:memory background)', () => {
  it('draws that session’s row again, and no other row', () => {
    dispatch({ type: 'state_change', sessionId: 'a2', state: 'working' })
    for (let i = 0; i < 5; i++)
      dispatch({ type: 'message_delta', sessionId: 'a2', seq: 1, role: 'assistant', messageId: 'm1', text: `piece ${i} ` })
    expect(new Set(drawn)).toEqual(new Set(['a2']))
  })

  it('draws a parent’s row again when a child it holds changes, and no sibling', () => {
    dispatch({ type: 'state_change', sessionId: 'a3', state: 'working' })
    expect(new Set(drawn)).toEqual(new Set(['a1', 'a3']))
  })

  it('does not draw another project’s block again', () => {
    dispatch({ type: 'state_change', sessionId: 'a2', state: 'working' })
    dispatch({ type: 'message_delta', sessionId: 'a2', seq: 1, role: 'assistant', messageId: 'm1', text: 'piece' })
    expect(blocks).not.toContain('p2')
    dispatch({ type: 'state_change', sessionId: 'b1', state: 'working' })
    expect(blocks).toContain('p2')
  })
})

describe('the top bar’s counts', () => {
  it('draw again when a count moves, not for a streamed piece', () => {
    let renders = 0
    function Counts() {
      useCounts()
      renders++
      return null
    }
    act(() => root.render(createElement(Counts)))
    dispatch({ type: 'state_change', sessionId: 'a2', state: 'working' })
    const before = renders
    for (let i = 0; i < 5; i++)
      dispatch({ type: 'message_delta', sessionId: 'a2', seq: 1, role: 'assistant', messageId: 'm1', text: `piece ${i} ` })
    expect(renders).toBe(before)
    dispatch({ type: 'state_change', sessionId: 'a2', state: 'waiting_input' })
    expect(renders).toBe(before + 1)
  })
})
