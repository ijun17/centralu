import type { NormalizedEvent } from '@cc/protocol'
import type { AppCaller, AppRef } from './apps/external/runtime.js'

type AppChanged = Extract<NormalizedEvent, { type: 'external_app_state_changed' }>

/**
 * 한 앱의 "바뀌었다"를 모으는 창. 창 안에 온 알림은 창 끝에 한 번으로 나간다 — 그래서 한 앱의 방송은 초당 4번을
 * 넘지 못한다. 사람 눈에는 한 박자 늦은 갱신이고, 바꾼 화면 자신은 호출의 답으로 곧바로 본다.
 */
export const APP_CHANGE_WINDOW_MS = 250

/**
 * 외부 앱의 "바뀌었다" 방송 (M4 B-5) — 런타임의 `emitChanged`를 앱마다 모아서 `external_app_state_changed`로 낸다.
 *
 * **마지막 방어선이다.** 열린 화면은 알림을 받으면 앱의 도구를 다시 부르고, 그 호출이 또 알림을 내면 고리가 된다.
 * 실측(65acb43): 템플릿 화면 하나가 초당 약 700번 `show`를 불렀다(3초에 실행 기록 2035줄). 고리는 앞의 두 겹에서
 * 먼저 끊긴다 — 읽기만 하는 도구는 알리지 않고(런타임), 화면은 자기가 낸 바뀜을 듣지 않는다(AppFrame). 그래도
 * 읽기 도구에 주석을 빠뜨린 앱이면, 같은 앱의 화면 둘(고정 화면과 대화 안 화면)이 서로의 다시 읽기를 듣고 주고받는다.
 * 여기서 모으면 그 주고받기도 한 앱에 초당 4번을 넘지 못한다.
 *
 * 자리를 UI 스토어가 아니라 host에 둔 이유: 홍수의 근원이 여기다. 여기서 막으면 모든 창, 모든 화면, 기록 판
 * (RunsPanel은 신호마다 기록을 다시 읽는다)이 함께 보호된다. 그리고 방송은 host의 이벤트 기록(링 버퍼 2000칸)에
 * 쌓인다 — 초당 700개면 3초 만에 세션 이벤트가 전부 밀려나, 다시 붙는 UI가 이어 받지 못하고 통째로 다시 읽는다.
 *
 * 모으는 동안 주인(`cause`)은 모두 같은 주인일 때만 남긴다. 섞이면 뺀다 — 남의 바뀜이 섞인 알림을 누군가 자기
 * 것으로 알고 건너뛰면, 그 화면은 낡은 값을 보여 준다.
 *
 * main.ts와 시험이 이 함수를 같이 쓴다(`app-list-events.ts`와 같은 자리). 시험이 도는 이음새가 곧 host의 이음새다.
 */
export function broadcastAppChanges(send: (e: AppChanged) => void, windowMs = APP_CHANGE_WINDOW_MS) {
  const pending = new Map<string, { ref: AppRef; cause: AppCaller | null; timer: NodeJS.Timeout }>()
  return {
    emit(ref: AppRef, cause: AppCaller | null = null): void {
      const key = JSON.stringify([ref.projectId, ref.appId])
      const open = pending.get(key)
      if (open) {
        if (!sameCause(open.cause, cause)) open.cause = null
        return
      }
      const timer = setTimeout(() => {
        const w = pending.get(key)
        pending.delete(key)
        if (w) send({ type: 'external_app_state_changed', appId: w.ref.appId, projectId: w.ref.projectId, ...(w.cause ? { cause: w.cause } : {}) })
      }, windowMs)
      timer.unref()
      pending.set(key, { ref, cause, timer })
    },
    dispose(): void {
      for (const w of pending.values()) clearTimeout(w.timer)
      pending.clear()
    },
  }
}

const sameCause = (a: AppCaller | null, b: AppCaller | null): boolean => a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)
