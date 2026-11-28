import { createRoot } from 'react-dom/client'
import { App, prepareFirstPaint, useStore } from '@cc/ui'
import { devTabKey } from './dev-tab-key.js'
import { createWebPlatform, type RpcClient } from '@cc/platform/web'
import { createMockPlatform } from '@cc/platform/mock'
import type { Platform } from '@cc/platform/ports'
import { startPlatform } from './bootstrap.js'
import '../../../packages/ui/src/styles/index.css'

/**
 * The only place that knows an implementation (docs/platform-abstraction.md §4). `?mock=1`: the empty in-memory mock
 * Playwright uses; `?demo[=focus|grid|empty|shot]`: a scene on the mock (`shot` is the README's screen); else the host.
 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// The last run's theme before anything is drawn, and the fonts the app is drawn after (firstPaint.ts says why)
const firstPaint = prepareFirstPaint()

const params = new URLSearchParams(location.search)
const demo = params.get('demo')
const root = createRoot(rootElement)
let rpcClient: RpcClient | null = null
// A failure is a screen to draw: thrown, it leaves a blank page
const started = startPlatform<Platform>(location.search, import.meta.env, {
  mock: seedMock,
  // A dev tab presents the key of the person's trust in every hello, so a reload keeps it (dev-tab-key.ts)
  host: (opts) => createWebPlatform({ ...opts, onRpcClient: (c) => (rpcClient = c), ...(import.meta.env.DEV ? { devTabKey: devTabKey.read } : {}) }),
})

function seedMock(): Platform {
  const mock = createMockPlatform()
  window.__mock = mock
  window.__store = useStore
  return mock
}

if (started.error) {
  root.render(
    <main className="flex min-h-screen items-center justify-center bg-base p-6 text-ink">
      <section className="max-w-xl rounded-lg border border-line bg-surface-raised p-5" role="alert" data-testid="startup-error">
        <p className="readout text-xs uppercase tracking-caps text-ink-muted">Centralu startup blocked</p>
        <h1 className="mt-2 text-display font-semibold">Host token is required</h1>
        <p className="mt-2 text-md text-ink-faint">{started.error.message}</p>
        <p className="mt-3 text-sm text-ink-faint">Use ?mock=1 or ?demo for browser-only mock mode, or launch the UI through the host so VITE_HOST_TOKEN is set.</p>
      </section>
    </main>,
  )
} else {
  // Before drawing: the app asks for its lists as it comes up, and a late scene draws a blank screen first
  if (demo !== null) {
    const { seedDemo, isDemoScene } = await import('@cc/platform/mock/demo')
    await seedDemo(started.platform as never, isDemoScene(demo) ? demo : 'focus')
  }

  let devBanner = null
  if (import.meta.env.DEV && rpcClient) {
    const { DevTrustBanner } = await import('./DevTrustBanner.js')
    devBanner = <DevTrustBanner rpc={rpcClient} />
  }

  await firstPaint
  root.render(<App platform={started.platform} banner={devBanner} />)
}
