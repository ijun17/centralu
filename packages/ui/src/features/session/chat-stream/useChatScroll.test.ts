import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useStore, type ChatItem } from '../../../store/store.js'
import { useChatScroll } from './useChatScroll.js'

/**
 * Where the conversation's view sits (#31, #61): following the bottom, letting go of a person who
 * scrolled up, and returning to the row left behind.
 *
 * The hook runs in real React. The node test run has no DOM (and a DOM library would have no
 * layout, which is all this hook reads), so what the hook touches is stood in for: a scroller that clamps `scrollTop` the way a browser does, a virtual scroller whose rows all
 * measure ROW px, and animation frames that run only when a test says so. A browser fires a scroll
 * event after every move; here a test calls `onScroll` where the browser would.
 */

/** A scroller with layout: the browser clamps scrollTop between 0 and the end */
class Scroller {
  clientHeight = 500
  scrollHeight = 0
  private top = 0
  get scrollTop() {
    return this.top
  }
  set scrollTop(v: number) {
    this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))
  }
  get bottom() {
    return this.scrollHeight - this.clientHeight
  }
  querySelectorAll() {
    return []
  }
  contains() {
    return false
  }
}

const ROW = 100
const rows = (from: number, n: number): ChatItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'assistant', seq: from + i, storedSeq: from + i, text: `L${from + i}` }))

/** The virtual scroller as the hook reads it: every row measured at ROW px, the last one `grown` px taller */
function virtualizerFor(chat: ChatItem[], grown: number) {
  const measurementsCache = chat.map((_, i) => ({ index: i, start: i * ROW, size: ROW, end: (i + 1) * ROW, key: i, lane: 0 }))
  return { measurementsCache, getTotalSize: () => chat.length * ROW + grown } as unknown as Virtualizer<HTMLDivElement, Element>
}

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let root: Root
let scroller: Scroller
let view: ReturnType<typeof useChatScroll>

/** Runs the frames the hook asked for, and those they ask for in turn, up to `n` rounds */
function runFrames(n = 60) {
  for (let i = 0; i < n && frames.size; i++) {
    const due = [...frames.values()]
    frames.clear()
    act(() => due.forEach((f) => f(performance.now())))
  }
}

function Probe(props: { sessionId: string; chat: ChatItem[]; grown: number }) {
  // ChatStream's refs are the same objects for the component's life; the hook's effects depend on that
  const scrollRef = useRef(scroller as unknown as HTMLDivElement)
  const stickToBottom = useRef(true)
  view = useChatScroll({
    sessionId: props.sessionId,
    scrollRef,
    chat: props.chat,
    virtualizer: virtualizerFor(props.chat, props.grown),
    stickToBottom,
    searchTarget: null,
    syncSticky: () => {},
    scheduleStickyOverlap: { current: () => {} },
    pending: null,
    working: false,
    bottomPad: undefined,
  })
  return null
}

/** Shows `chat` for `sessionId` in the one pane, the way the focus view swaps sessions under one component */
function show(sessionId: string, chat: ChatItem[], grown = 0) {
  scroller.scrollHeight = chat.length * ROW + grown
  act(() => root.render(createElement(Probe, { sessionId, chat, grown })))
}

/** A wheel on the conversation, as ChatStream wires it, then the scroll event the move fires */
function wheelTo(top: number) {
  act(() => {
    view.endLanding()
    view.noteInput()
    scroller.scrollTop = top
    view.onScroll()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
    frames.set(++nextFrame, f)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  // Just enough of a container for React DOM to mount a component that renders nothing
  const doc = { addEventListener() {}, removeEventListener() {}, defaultView: { document: { activeElement: null }, HTMLIFrameElement: class {} } }
  root = createRoot({
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
    addEventListener() {}, removeEventListener() {}, textContent: '',
  } as unknown as Element)
  scroller = new Scroller()
  useStore.setState({ stickToBottom: {}, scrollAnchor: {} })
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

describe('landing when a conversation opens', () => {
  it('lands at the bottom and shows the view once it is there', () => {
    show('s1', rows(1, 20))
    expect(view.settling).toBe(true)
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
    expect(view.settling).toBe(false)
  })

  it('keeps landing while the rows measure taller than guessed, until the bottom stops moving', () => {
    const chat = rows(1, 20)
    show('s1', chat)
    runFrames(1)
    // The rows measured: the end moved down after the first aim
    scroller.scrollHeight += 700
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })

  it('a wheel during the landing ends it: the view stays where the person put it', () => {
    show('s1', rows(1, 20))
    runFrames(1)
    wheelTo(300)
    runFrames()
    expect(scroller.scrollTop).toBe(300)
    expect(view.settling).toBe(false)
  })
})

describe('following the bottom', () => {
  it('follows new rows while the view is at the bottom', () => {
    show('s1', rows(1, 20))
    runFrames()
    show('s1', rows(1, 25))
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })

  it('follows a streaming answer that grows its last row without adding one', () => {
    const chat = rows(1, 20)
    show('s1', chat)
    runFrames()
    show('s1', chat, 450)
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })

  it('never pulls a person who scrolled up back down when content arrives', () => {
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(300)
    show('s1', rows(1, 25))
    runFrames()
    expect(scroller.scrollTop).toBe(300)
  })

  it('lets go when the person moved the view up just before its scroll event, as content grows', () => {
    show('s1', rows(1, 20))
    runFrames()
    act(() => {
      view.noteInput()
      scroller.scrollTop = 300
    })
    show('s1', rows(1, 25))
    runFrames()
    expect(scroller.scrollTop).toBe(300)
  })

  it('keeps following through a drop nobody made (the browser clamping while rows measure)', () => {
    show('s1', rows(1, 20))
    runFrames()
    act(() => {
      scroller.scrollTop = 300
    })
    show('s1', rows(1, 25))
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })

  it('follows again once the person scrolls back to the bottom', () => {
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(300)
    wheelTo(scroller.bottom)
    show('s1', rows(1, 25))
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })
})

describe('returning to the row left behind', () => {
  it('leaving a conversation read halfway up keeps the row being read, and coming back returns to it', () => {
    const chat = rows(1, 20)
    show('s1', chat)
    runFrames()
    wheelTo(1234)

    show('s2', rows(101, 20))
    expect(useStore.getState().stickToBottom['s1']).toBe(false)
    // Row 13 (from 1200) is at the top, 34 px of it scrolled past: a row, not a pixel, survives re-measuring
    expect(useStore.getState().scrollAnchor['s1']).toEqual({ seq: 13, offset: 34 })
    runFrames()

    show('s1', chat)
    runFrames()
    expect(scroller.scrollTop).toBe(1234)
  })

  it('returns to the same row when older pages were prepended above it meanwhile', () => {
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(1234)
    show('s2', rows(101, 20))
    runFrames()

    // Reading back put ten older rows above the one left behind
    show('s1', [...rows(-9, 10), ...rows(1, 20)])
    runFrames()
    expect(scroller.scrollTop).toBe(1234 + 10 * ROW)
  })

  it('leaving at the bottom forgets the row left before, and coming back lands at the new bottom', () => {
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(1234)
    show('s2', rows(101, 20))
    runFrames()
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(scroller.bottom)

    show('s2', rows(101, 20))
    // Sticking is the default, recorded by not being recorded
    expect(useStore.getState().stickToBottom['s1']).toBeUndefined()
    expect(useStore.getState().scrollAnchor['s1']).toBeUndefined()
    runFrames()

    show('s1', rows(1, 30))
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })

  it('the next session does not inherit the previous one\'s position', () => {
    show('s1', rows(1, 20))
    runFrames()
    wheelTo(300)
    show('s2', rows(101, 20))
    runFrames()
    expect(scroller.scrollTop).toBe(scroller.bottom)
  })
})
