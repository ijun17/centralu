import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useUpdateCheckWhileOpen } from './apply-update.js'

/**
 * The check Updates asks for as Settings opens (#2155). Settings reopened during its closing fade is still mounted, so
 * the check has to follow Settings opening, not the view mounting.
 *
 * The hook runs in real React; the node test run has no DOM, so the container is just enough for React DOM to mount a
 * component that renders nothing (as in useChatScroll.test.ts).
 */

const status: UpdateStatus = {
  current: '0.1.0-beta.2',
  latest: '0.1.0-beta.2',
  newer: false,
  auto: true,
  autoApply: false,
  phase: 'idle',
  error: null,
  checkedAt: 1,
}

let root: Root
let checkUpdate: ReturnType<typeof vi.fn<(force?: boolean) => Promise<void>>>
const initial = useStore.getState()

function Probe() {
  useUpdateCheckWhileOpen()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const doc = { addEventListener() {}, removeEventListener() {}, defaultView: { document: { activeElement: null }, HTMLIFrameElement: class {} } }
  root = createRoot({
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
    addEventListener() {}, removeEventListener() {}, textContent: '',
  } as unknown as Element)
  checkUpdate = vi.fn(async () => {})
  useStore.setState({ checkUpdate, update: status, settingsOpen: true })
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  useStore.setState(initial, true)
})

describe('Updates asks again each time Settings opens (#2155)', () => {
  it('asks when it mounts in an open Settings', () => {
    act(() => root.render(createElement(Probe)))
    expect(checkUpdate).toHaveBeenCalledTimes(1)
    expect(checkUpdate).toHaveBeenCalledWith(true)
  })

  it('asks again when Settings is reopened while the view is still mounted', () => {
    act(() => root.render(createElement(Probe)))
    // Closing: the fade keeps the view mounted, and closing asks nothing
    act(() => useStore.setState({ settingsOpen: false }))
    expect(checkUpdate).toHaveBeenCalledTimes(1)
    // Reopened before the fade ended: the same mounted view
    act(() => useStore.setState({ settingsOpen: true }))
    expect(checkUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not ask over a check or an install under way, nor with automatic checking off', () => {
    for (const update of [{ ...status, phase: 'checking' as const }, { ...status, phase: 'updating' as const }, { ...status, auto: false }]) {
      act(() => useStore.setState({ update, settingsOpen: false }))
      act(() => root.render(createElement(Probe)))
      act(() => useStore.setState({ settingsOpen: true }))
    }
    expect(checkUpdate).not.toHaveBeenCalled()
  })
})
