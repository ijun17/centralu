import { createRoot } from 'react-dom/client'
import { App, ShellBanner, useStore } from '@cc/ui'
import { createMockPlatform } from '@cc/platform/mock'
import { isDemoScene, seedDemo } from '@cc/platform/mock/demo'
import '../../../../packages/ui/src/styles/index.css'

/**
 * A test rig for App's `banner` slot (#326, exclusively for e2e/shell-banner*.spec.ts).
 *
 * The only banner today is the desktop keeper's "other build" bar, and it only exists inside
 * Tauri with a keeper attached. So this stands the whole App up on the mock, the way the browser
 * entry does, and hands it a ShellBanner with the same content shapes that bar draws: one long
 * line of build text plus its buttons, the switch progress, or a failure with its reason.
 *
 * The mock reports no window controls (a browser has none), so this one says 86px, what
 * `window_controls_inset` returns on macOS, and draws three dots where trafficLightPosition puts
 * the traffic lights. The dots are inert (pointer-events: none) and only make a screenshot
 * readable; the spec reads the same position from tauri.conf.json to measure against.
 *
 * Query: `?demo=focus|grid` picks the scene, `?state=other|progress|failed` the banner.
 *
 * Only on the dev server: `vite build`'s only input is index.html.
 */

const MACOS_CONTROLS_INSET = 86
const LIGHTS = { x: 19, y: 12, size: 12, gap: 8 }

const params = new URLSearchParams(location.search)
const scene = params.get('demo') ?? 'focus'
const state = params.get('state') ?? 'other'

const mock = createMockPlatform()
;(mock.capabilities as { windowControlsInset: number }).windowControlsInset = MACOS_CONTROLS_INSET
window.__mock = mock
window.__store = useStore

function Banner() {
  if (state === 'progress' || state === 'failed') {
    return (
      <ShellBanner testId="host-other-build" role={state === 'failed' ? 'alert' : 'status'}>
        <span
          className={`min-w-0 flex-1 truncate ${state === 'failed' ? 'text-danger' : ''}`}
          data-testid="host-switch-progress"
        >
          {state === 'failed'
            ? 'Could not switch: the new agent host did not answer within 30 seconds, so the running host at build 2ffcaec5 (0.1.0-beta.6) keeps serving this window.'
            : 'Starting the agent host from build 53b9cf7 (0.1.0-beta.7) next to the running one; open sessions move over when it answers.'}
        </span>
        {state === 'failed' && <button className="shrink-0 text-ink-faint hover:text-ink">Dismiss</button>}
      </ShellBanner>
    )
  }
  return (
    <ShellBanner testId="host-other-build" role="status">
      <span className="min-w-0 flex-1 truncate">
        The agent host is running build 2ffcaec5 (0.1.0-beta.6) from /Applications/Centralu.app. This window
        is build 53b9cf7 (0.1.0-beta.7) from /Users/someone/Downloads/Centralu 0.1.0-beta.7/Centralu.app.
      </span>
      <button
        className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink hover:border-line-strong"
        data-testid="host-switch-build"
      >
        Switch to this build
      </button>
      <button className="shrink-0 text-ink-faint hover:text-ink">Not now</button>
    </ShellBanner>
  )
}

function TrafficLights() {
  return (
    <div
      aria-hidden
      data-testid="fake-traffic-lights"
      style={{
        position: 'fixed',
        left: LIGHTS.x,
        top: LIGHTS.y,
        display: 'flex',
        gap: LIGHTS.gap,
        pointerEvents: 'none',
        zIndex: 100,
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <span
          key={c}
          style={{ width: LIGHTS.size, height: LIGHTS.size, borderRadius: '50%', background: c }}
        />
      ))}
    </div>
  )
}

void (async () => {
  await seedDemo(mock, isDemoScene(scene) ? scene : 'focus')
  createRoot(document.getElementById('root')!).render(
    <>
      <App platform={mock} banner={<Banner />} />
      <TrafficLights />
    </>,
  )
})()
