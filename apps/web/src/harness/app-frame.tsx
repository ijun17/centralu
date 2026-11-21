import { createRef, useSyncExternalStore, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { AppFrame, PlatformProvider, applyTypography, typographyOf, useStore, type AppFrameHandle, type AppFrameProps } from '@cc/ui'
import { createMockPlatform } from '@cc/platform/mock'
import type { AppViewFrame } from '@cc/platform/ports'
import '../../../../packages/ui/src/styles/index.css'

/**
 * AppFrame alone on a mock platform, for e2e/app-frame.spec.ts. The test plugs a real HostServer's ViewHost `frame()`
 * in through `window.__viewFrame`, so the proxy, CSP, secret path and the store's wiring are real. Dev server only.
 */

type Mounted = { key: string; props: AppFrameProps; ref: RefObject<AppFrameHandle | null> }

declare global {
  interface Window {
    __viewFrame?: (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => Promise<AppViewFrame>
    __appFrame?: {
      mount(key: string, props: AppFrameProps): void
      update(key: string, patch: Partial<AppFrameProps>): void
      /** Teardown first, then taken down once it answers: the order the parent has to follow */
      close(key: string): Promise<string>
      /** Without teardown */
      drop(key: string): void
      events: { kind: string; key: string; value: unknown }[]
    }
  }
}

const mock = createMockPlatform()
window.__mock = mock
window.__store = useStore
// As App.tsx puts them on the root (#312), for the app-theme e2e
;(window as never as { __typography: unknown }).__typography = (prefs: Parameters<typeof typographyOf>[0]) => applyTypography(typographyOf(prefs))
mock.viewFrameProvider = (appId, instanceId, opts) => {
  if (!window.__viewFrame) throw new Error('No view host is attached to this harness')
  return window.__viewFrame(appId, instanceId, opts)
}
void useStore.getState().attach(mock)

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
    <main className="min-h-screen bg-surface-floor p-4 text-ink">
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
