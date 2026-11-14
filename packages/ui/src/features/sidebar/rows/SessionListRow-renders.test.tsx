/**
 * What an event of one session draws again in the sidebar: that session's row, and nothing in another project. Every
 * event of every session used to draw every row of every project, a streamed reply's every piece included, and that was
 * most of what the window allocated while sessions worked out of view (perf:memory --steps background).
 *
 * Real React and the real store; the node test run has no DOM, so the row's element (`SessionRow`) is replaced by one
 * that counts and draws nothing, and nothing here makes an element (as in useChatScroll.test.ts).
 */
import { act, createElement, Fragment, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol/client'
import { sessionFromInfo } from '../../../store/sessionList.js'
import { useCounts, useSessionsOf } from '../../../store/selectors.js'
import { useStore } from '../../../store/store.js'
import { resetStore, sessionInfo } from '../../../store/store.test-helpers.js'
import { treeRows } from '../tree.js'

const drawn: string[] = []
vi.mock('./SessionRow.jsx', () => ({
  SessionRow: ({ id }: { id: string }) => {
    drawn.push(id)
    return null
  },
}))
const { SessionListRow } = await import('./SessionListRow.jsx')

const keep = () => {}
const noReorder = (_row: string, _dragged: string, _before: boolean) => {}
const blocks: string[] = []

/** A project's rows as its block draws them, with the functions a list passes staying the same */
function Rows({ projectId }: { projectId: string }) {
  const sessions = useSessionsOf(projectId)
  blocks.push(projectId)
  const props: Omit<ComponentProps<typeof SessionListRow>, 'row'> = {
    projectId,
    onReorder: noReorder,
    focusedSessionId: null,
    renaming: null,
    setRenaming: keep,
    sessionMenu: null,
    setSessionMenu: keep,
    setHandingOff: keep,
    setConfirming: keep,
  }
  return createElement(
    Fragment,
    null,
    treeRows(sessions, () => false).map((row) => createElement(SessionListRow, { key: row.s.id, row, ...props })),
  )
}

let root: Root
const initial = useStore.getState()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const doc = { addEventListener() {}, removeEventListener() {}, defaultView: { document: { activeElement: null }, HTMLIFrameElement: class {} } }
  root = createRoot({
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
    addEventListener() {}, removeEventListener() {}, textContent: '',
  } as unknown as Element)
  resetStore()
  const info = [sessionInfo('a1'), sessionInfo('a2'), sessionInfo('a3', { parentSessionId: 'a1' }), sessionInfo('b1', { projectId: 'p2' })]
  useStore.setState({ sessions: Object.fromEntries(info.map((i) => [i.id, sessionFromInfo(i)])) })
  act(() => root.render(createElement(Fragment, null, createElement(Rows, { projectId: 'p1' }), createElement(Rows, { projectId: 'p2' }))))
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
