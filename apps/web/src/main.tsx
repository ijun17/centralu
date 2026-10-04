import { createRoot } from 'react-dom/client'
import { App, applyCachedTheme, useStore } from '@cc/ui'
import { createWebPlatform } from '@cc/platform/web'
import { createMockPlatform } from '@cc/platform/mock'
import type { Platform } from '@cc/platform/ports'
import { startPlatform } from './bootstrap.js'
import '../../../packages/ui/src/styles/index.css'

/**
 * The only place that knows about a concrete implementation (docs/platform-abstraction.md §4).
 *
 * Only two things can follow the question mark:
 *
 *   ?mock=1            Launches with the in-memory implementation. **A blank screen** — this
 *                      is the path Playwright uses.
 *   ?demo[=scene]      Lays a scene on top of that (project, session, conversation, git,
 *                      usage). Talking to it gets a real answer back.
 *                      Scenes: focus (default) · grid · empty · shot (one English screen for
 *                      the README)
 *
 * `demo` implies `mock` — a scene only grows on top of the mock. With nothing appended, it
 * connects to the real host (ws://127.0.0.1:5175).
 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// The theme the last run chose, before anything is drawn — the preferences arrive a round trip later (theme.ts)
applyCachedTheme()

const params = new URLSearchParams(location.search)
const demo = params.get('demo')
const root = createRoot(rootElement)
/* A failure is also **a screen that has to be drawn** — throwing it leaves a blank page. The
   boundary lives in bootstrap. */
const started = startPlatform<Platform>(location.search, import.meta.env, {
  mock: seedMock,
  host: createWebPlatform,
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
  /*
   * The scene is laid down **before drawing anything.** Since the app asks for its lists the
   * moment it comes up, laying it down late would mean drawing a blank screen once before the
   * content arrives — not the screen the person came to see.
   */
  if (demo !== null) {
    const { seedDemo, isDemoScene } = await import('@cc/platform/mock/demo')
    await seedDemo(started.platform as never, isDemoScene(demo) ? demo : 'focus')
  }

  root.render(<App platform={started.platform} />)
}
