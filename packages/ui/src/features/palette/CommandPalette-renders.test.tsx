/**
 * A closed palette, mounted for the window's life, is not drawn again for every session event (each streamed piece
 * included). Real React and store; it draws nothing, so the node run needs no DOM (as update-check-on-open.test.ts).
 */
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'
import { sessionFromInfo } from '../../store/sessionList.js'
import { useStore } from '../../store/store.js'
import { resetStore, sessionInfo } from '../../store/store.test-helpers.js'
import { CommandPalette } from './CommandPalette.jsx'

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
  useStore.setState({ paletteOpen: false, sessions: { s1: sessionFromInfo(sessionInfo('s1')) } })
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  useStore.setState(initial, true)
})

describe('a closed palette', () => {
  it('is not drawn again for a session’s events', () => {
    let commits = 0
    const tree = createElement(PlatformProvider, {
      platform: new MockPlatform(),
      children: createElement(Profiler, { id: 'palette', onRender: () => commits++ }, createElement(CommandPalette)),
    })
    act(() => root.render(tree))
    const before = commits
    act(() => useStore.getState().dispatchEvent({ type: 'state_change', sessionId: 's1', state: 'working' }))
    for (let i = 0; i < 5; i++)
      act(() =>
        useStore.getState().dispatchEvent({ type: 'message_delta', sessionId: 's1', seq: 1, role: 'assistant', messageId: 'm1', text: `piece ${i} ` }),
      )
    expect(commits).toBe(before)
  })
})
