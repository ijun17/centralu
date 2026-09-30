import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { APP_CHANGE_WINDOW_MS, broadcastAppChanges } from './app-change-events.js'
import type { AppCaller, AppRef } from './apps/external/runtime.js'

/**
 * The external app "changed" broadcast (M4 B-5) — the exact `broadcastAppChanges` that main.ts
 * uses.
 *
 * Because this is the last line of defense, it checks the ceiling by simulating a loop where both
 * of the earlier two layers (reads are not broadcast; a view does not hear its own change) have
 * been breached. Measured (65acb43): with nothing to stop it, a single template view called `show`
 * about 700 times per second.
 */

type Sent = Extract<NormalizedEvent, { type: 'external_app_state_changed' }>
const notes: AppRef = { projectId: 'p1', appId: 'notes' }
const frameA: AppCaller = { kind: 'view', instanceId: 'frame-a' }

let sent: Sent[] = []
let stops: (() => void)[] = []
const make = (onSend: (e: Sent) => void = () => {}) => {
  const b = broadcastAppChanges((e) => {
    sent.push(e)
    onSend(e)
  })
  stops.push(b.dispose)
  return b
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  stops = []
})
afterEach(() => {
  for (const stop of stops) stop()
  vi.useRealTimers()
})

describe('the external app "changed" broadcast — collected per app', () => {
  it('100 notifications within one window go out as one at the end of the window, and if all of them are from one view that view is carried as the cause', () => {
    const b = make()
    for (let i = 0; i < 100; i++) b.emit(notes, frameA)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    expect(sent).toEqual([{ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', cause: frameA }])
  })

  it('a loop that reads again the moment it receives, and notifies again, runs at 4 per second for one app', () => {
    // The fastest shape of the loop: a view that received the broadcast reads again immediately,
    // and that read produces another change
    const loop = make(() => loop.emit(notes, frameA))
    loop.emit(notes, frameA)
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(4)
  })

  it('a relentless notification (every 1ms) is still 4 per second for one app — the window keeps getting pushed back but never starves it', () => {
    const b = make()
    for (let t = 0; t < 1000; t++) {
      b.emit({ projectId: null, appId: 'timer' }, null)
      vi.advanceTimersByTime(1)
    }
    expect(sent).toHaveLength(4)
  })

  it("a window with mixed causes goes out with no cause — so that no one mistakes a notification mixed with someone else's change for its own and skips it", () => {
    const b = make()
    b.emit(notes, frameA)
    b.emit(notes, { kind: 'session', sessionId: 's1' })
    b.emit(notes, frameA)
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    // Same result even when it is another view's emission that got mixed in
    b.emit(notes, frameA)
    b.emit(notes, { kind: 'view', instanceId: 'frame-b' })
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    expect(sent).toEqual([
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' },
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' },
    ])
  })

  it('collects separately per app — an app of the same name in another project is a different app', () => {
    const b = make()
    b.emit(notes, frameA)
    b.emit({ projectId: 'p2', appId: 'notes' }, { kind: 'session', sessionId: 's1' })
    b.emit({ projectId: null, appId: 'notes' }, null)
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    expect(sent).toEqual([
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', cause: frameA },
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p2', cause: { kind: 'session', sessionId: 's1' } },
      { type: 'external_app_state_changed', appId: 'notes', projectId: null },
    ])
  })
})
