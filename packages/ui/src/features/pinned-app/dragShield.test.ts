import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEAVE_GRACE_MS, watchDrags } from './dragShield.jsx'

/**
 * When the cover over the app views goes on and comes off (#296): for the length of any drag, and not a moment after.
 * A cover left behind takes every click meant for the frames, so each way a drag ends is here. Whether the cover
 * catches the drag on a real page is e2e's (fixtures/project-screen.ts, fixtures/grid-apps.ts).
 */

let win: EventTarget
let seen: boolean[]
let stop: () => void
const now = () => seen.at(-1) ?? false
const fire = (type: string, extra: Record<string, unknown> = {}) => win.dispatchEvent(Object.assign(new Event(type), extra))

beforeEach(() => {
  vi.useFakeTimers()
  win = new EventTarget()
  seen = []
  stop = watchDrags(win, (on) => seen.push(on))
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('watchDrags', () => {
  it('a drag started in the window is on until its drop, which ends it only after the drop has been handled', () => {
    fire('dragstart')
    expect(now()).toBe(true)
    fire('dragover')
    fire('drop')
    // Still on while the drop reaches its target: the cover under it is what the target is found through
    expect(now()).toBe(true)
    vi.advanceTimersByTime(0)
    expect(now()).toBe(false)
  })

  it('a drag let go outside any target ends with its dragend', () => {
    fire('dragstart')
    fire('dragend')
    vi.advanceTimersByTime(0)
    expect(now()).toBe(false)
  })

  it('a drag that comes in from outside (a file from the OS) is on from its first dragenter', () => {
    fire('dragenter')
    expect(now()).toBe(true)
  })

  it('a drag that leaves the window ends after a moment with nothing entered', () => {
    fire('dragenter')
    fire('dragleave', { relatedTarget: null })
    vi.advanceTimersByTime(LEAVE_GRACE_MS - 1)
    expect(now()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(now()).toBe(false)
  })

  it('moving from one element to the next inside the window does not end it, whatever relatedTarget says', () => {
    fire('dragstart')
    // The order engines send: the new element's dragenter, the old one's dragleave, then dragover on the new one
    fire('dragenter')
    fire('dragleave', { relatedTarget: null })
    fire('dragover')
    vi.advanceTimersByTime(LEAVE_GRACE_MS * 4)
    expect(now()).toBe(true)
    fire('dragleave', { relatedTarget: {} })
    vi.advanceTimersByTime(LEAVE_GRACE_MS * 4)
    expect(now()).toBe(true)
  })

  it('a real mouse move with no button held ends a drag whose end was missed; a still one does not', () => {
    fire('dragstart')
    // What an engine sends by itself when the page changes under a still pointer
    fire('mousemove', { buttons: 0, movementX: 0, movementY: 0 })
    expect(now()).toBe(true)
    // A button still held: the drag's own gesture
    fire('mousemove', { buttons: 1, movementX: 4, movementY: 0 })
    expect(now()).toBe(true)
    fire('mousemove', { buttons: 0, movementX: 4, movementY: 1 })
    expect(now()).toBe(false)
  })

  it('a new drag started right after a drop stays on', () => {
    fire('dragstart')
    fire('drop')
    fire('dragstart')
    vi.advanceTimersByTime(LEAVE_GRACE_MS)
    expect(now()).toBe(true)
  })

  it('stops listening when stopped', () => {
    stop()
    fire('dragstart')
    expect(seen).toEqual([])
  })
})
