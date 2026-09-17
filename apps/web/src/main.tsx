import { createRoot } from 'react-dom/client'
import { App, useStore } from '@cc/ui'
import { createWebPlatform } from '@cc/platform/web'
import { createMockPlatform } from '@cc/platform/mock'
import type { Platform } from '@cc/platform/ports'
import { browserHostOptions, isMockMode } from './bootstrap.js'
import '../../../packages/ui/src/styles/index.css'

/**
 * 구현체를 아는 유일한 곳 (docs/platform-abstraction.md §4).
 *
 * 물음표 뒤에 붙일 수 있는 것은 둘뿐이다:
 *
 *   ?mock=1            인메모리 구현으로 뜬다. **빈 화면** — Playwright가 쓰는 길이다.
 *   ?demo[=씬]         그 위에 씬을 깐다 (프로젝트·세션·대화·깃·사용량). 말을 걸면 답이 온다.
 *                      씬: focus(기본) · grid · empty
 *
 * `demo`는 `mock`을 함의한다 — 씬은 목 위에서만 자란다. 아무것도 안 붙이면 진짜 host에
 * 붙는다 (ws://127.0.0.1:5175).
 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

const params = new URLSearchParams(location.search)
const demo = params.get('demo')
const root = createRoot(rootElement)
let platform: Platform | null = null
let startupError: Error | null = null

try {
  platform = isMockMode(location.search) ? seedMock() : createWebPlatform(browserHostOptions(import.meta.env))
} catch (error) {
  startupError = error instanceof Error ? error : new Error(String(error))
}

function seedMock(): Platform {
  const mock = createMockPlatform()
  window.__mock = mock
  window.__store = useStore
  return mock
}

if (startupError) {
  root.render(
    <main className="flex min-h-screen items-center justify-center bg-base p-6 text-chalk">
      <section className="max-w-xl rounded-xl border border-edge bg-panel p-5 shadow-panel" role="alert" data-testid="startup-error">
        <p className="readout text-[11px] uppercase tracking-[0.2em] text-ash">Centralu startup blocked</p>
        <h1 className="mt-2 text-lg font-semibold">Host token is required</h1>
        <p className="mt-2 text-sm text-slate">{startupError.message}</p>
        <p className="mt-3 text-xs text-slate">Use ?mock=1 or ?demo for browser-only mock mode, or launch the UI through the host so VITE_HOST_TOKEN is set.</p>
      </section>
    </main>,
  )
} else {
  /*
   * 씬은 **그리기 전에** 깔린다. 앱은 뜨자마자 목록을 물으므로, 늦게 깔면 빈 화면을 한 번
   * 그린 뒤에야 내용이 들어온다 — 사람이 보려던 그 화면이 아니다.
   */
  if (demo !== null) {
    const { seedDemo, isDemoScene } = await import('@cc/platform/mock/demo')
    await seedDemo(platform as never, isDemoScene(demo) ? demo : 'focus')
  }

  root.render(<App platform={platform!} />)
}
