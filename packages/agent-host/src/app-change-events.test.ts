import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { APP_CHANGE_WINDOW_MS, broadcastAppChanges } from './app-change-events.js'
import type { AppCaller, AppRef } from './apps/external/runtime.js'

/**
 * 외부 앱의 "바뀌었다" 방송 (M4 B-5) — main.ts가 쓰는 `broadcastAppChanges` 그대로.
 *
 * 마지막 방어선이라, 앞의 두 겹(읽기는 알리지 않는다, 화면은 자기 바뀜을 듣지 않는다)이 모두 뚫린 고리를 흉내 내
 * 상한을 본다. 실측(65acb43): 막는 것이 없을 때 템플릿 화면 하나가 초당 약 700번 `show`를 불렀다.
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

describe('외부 앱의 "바뀌었다" 방송 — 앱마다 모은다', () => {
  it('한 창 안의 알림 100개는 창 끝에 하나로 나가고, 모두 한 화면의 것이면 그 화면이 주인으로 실린다', () => {
    const b = make()
    for (let i = 0; i < 100; i++) b.emit(notes, frameA)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    expect(sent).toEqual([{ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', cause: frameA }])
  })

  it('받자마자 다시 읽어 또 알리는 고리는 한 앱에 초당 4번으로 돈다', () => {
    // 고리의 가장 빠른 모양: 방송을 받은 화면이 곧바로 다시 읽고, 그 읽기가 또 바뀜을 낸다
    const loop = make(() => loop.emit(notes, frameA))
    loop.emit(notes, frameA)
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(4)
  })

  it('쉬지 않는 알림(1ms마다)도 한 앱에 초당 4번이다 — 창이 계속 밀려 끊기지는 않는다', () => {
    const b = make()
    for (let t = 0; t < 1000; t++) {
      b.emit({ projectId: null, appId: 'timer' }, null)
      vi.advanceTimersByTime(1)
    }
    expect(sent).toHaveLength(4)
  })

  it('주인이 섞인 창은 주인 없이 나간다 — 남의 바뀜이 섞인 알림을 누구도 자기 것으로 알고 건너뛰지 않게', () => {
    const b = make()
    b.emit(notes, frameA)
    b.emit(notes, { kind: 'session', sessionId: 's1' })
    b.emit(notes, frameA)
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    // 다른 화면이 낸 것이 섞여도 마찬가지다
    b.emit(notes, frameA)
    b.emit(notes, { kind: 'view', instanceId: 'frame-b' })
    vi.advanceTimersByTime(APP_CHANGE_WINDOW_MS)
    expect(sent).toEqual([
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' },
      { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' },
    ])
  })

  it('앱마다 따로 모은다 — 다른 프로젝트의 같은 이름 앱도 남이다', () => {
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
