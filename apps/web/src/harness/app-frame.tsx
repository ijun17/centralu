import { createRef, useSyncExternalStore, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { AppFrame, PlatformProvider, useStore, type AppFrameHandle, type AppFrameProps } from '@cc/ui'
import { createMockPlatform } from '@cc/platform/mock'
import type { AppViewFrame } from '@cc/platform/ports'
import '../../../../packages/ui/src/styles/index.css'

/**
 * AppFrame 시험대 (M4 B-3c, e2e/app-frame.spec.ts 전용).
 *
 * 앱 화면을 대화 카드 아래에 붙이는 일(B-1)은 아직 없다. 그래서 컴포넌트를 목 플랫폼 위에
 * 홀로 세운다. 화면 주소만은 진짜 host 코드가 만든다. 시험이 Node 쪽에 HostServer와 ViewHost를
 * 띄우고, `window.__viewFrame`으로 그 `frame()`을 꽂는다. 그래서 프록시·CSP·비밀 경로는 모두
 * 실물이다.
 *
 * 개발 서버에서만 뜬다. `vite build`의 입력은 index.html 하나라 배포물에 들어가지 않는다.
 */

type Mounted = { key: string; props: AppFrameProps; ref: RefObject<AppFrameHandle | null> }

declare global {
  interface Window {
    __viewFrame?: (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => Promise<AppViewFrame>
    __appFrame?: {
      mount(key: string, props: AppFrameProps): void
      update(key: string, patch: Partial<AppFrameProps>): void
      /** 부모가 해야 할 순서: teardown을 먼저 부르고, 답을 받은 뒤 내린다 */
      close(key: string): Promise<string>
      /** teardown 없이 곧바로 내린다 */
      drop(key: string): void
      events: { kind: string; key: string; value: unknown }[]
    }
  }
}

const mock = createMockPlatform()
window.__mock = mock
window.__store = useStore
mock.viewFrameProvider = (appId, instanceId, opts) => {
  if (!window.__viewFrame) throw new Error('No view host is attached to this harness')
  return window.__viewFrame(appId, instanceId, opts)
}

let frames: Mounted[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const events: { kind: string; key: string; value: unknown }[] = []

window.__appFrame = {
  events,
  mount(key, props) {
    frames = [...frames.filter((f) => f.key !== key), { key, props, ref: createRef<AppFrameHandle>() }]
    emit()
  },
  update(key, patch) {
    frames = frames.map((f) => (f.key === key ? { ...f, props: { ...f.props, ...patch } } : f))
    emit()
  },
  async close(key) {
    const f = frames.find((x) => x.key === key)
    const outcome = (await f?.ref.current?.teardown()) ?? 'missing'
    events.push({ kind: 'teardown', key, value: outcome })
    frames = frames.filter((x) => x.key !== key)
    emit()
    return outcome
  },
  drop(key) {
    frames = frames.filter((x) => x.key !== key)
    emit()
  },
}

function Harness() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => frames,
  )
  return (
    <main className="min-h-screen bg-void p-4 text-chalk">
      {list.map((f) => (
        <section key={f.key} data-testid={`frame-${f.key}`} className="mb-4">
          <AppFrame
            ref={f.ref}
            {...f.props}
            onMessage={(m) => {
              events.push({ kind: 'message', key: f.key, value: m })
            }}
          />
        </section>
      ))}
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')
createRoot(root).render(
  <PlatformProvider platform={mock}>
    <Harness />
  </PlatformProvider>,
)
