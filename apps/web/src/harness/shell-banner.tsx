import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, useStore } from '@cc/ui'
import { createMockPlatform } from '@cc/platform/mock'
import { isDemoScene, seedDemo } from '@cc/platform/mock/demo'
import type { HostBuild } from '@cc/platform/tauri'
import { buildBar } from '../../../../packages/platform/src/tauri/switch-plan.js'
import { BuildBarView, RestartKeeperDialog } from '../../../desktop/src/build-bar.js'
import { QuitDialog } from '../../../desktop/src/quit-dialog.js'
import '../../../../packages/ui/src/styles/index.css'

/**
 * A test rig for the desktop shell's own surfaces (#326, #387, exclusively for
 * e2e/shell-banner*.spec.ts and e2e/quit-dialog.spec.ts).
 *
 * The keeper's build bar and the quit question only exist inside Tauri. So this stands the whole
 * App up on the mock, the way the browser entry does, and draws **the desktop's own components**
 * (apps/desktop/src/build-bar.tsx, quit-dialog.tsx) with a made-up `HostBuild`, decided by the same
 * `buildBar` the desktop calls. What the buttons would do in the app is recorded in
 * `window.__shellCalls` instead.
 *
 * The mock reports no window controls (a browser has none), so this one says 86px, what
 * `window_controls_inset` returns on macOS, and draws three dots where trafficLightPosition puts
 * the traffic lights. The dots are inert (pointer-events: none) and only make a screenshot
 * readable; the spec reads the same position from tauri.conf.json to measure against.
 *
 * Query: `?demo=focus|grid` picks the scene; `?state=` the keeper's report:
 *   - `other`: the host is of another build (the switch is offered)
 *   - `older`: this window is an older build than the host and the keeper (#352: a backed-up
 *     app opened while a newer one runs; the switch back is offered, by hand only)
 *   - `progress`: a swap is starting
 *   - `failed`: a swap failed before the old host was touched (a real failure)
 *   - `keeper-later`: the host is on this build and the keeper could not move (beta.10's
 *     "Message too long", the second click), `keeper-later-first`: the same on the first click
 *   - `shell`: everything on this build, but a release started its keeper without the permission
 *     shell (thin-shell plan §6), which refused the content
 * `?dialog=quit&background=on|off` opens the quit question instead.
 *
 * Only on the dev server: `vite build`'s only input is index.html.
 */

const MACOS_CONTROLS_INSET = 86
const LIGHTS = { x: 19, y: 12, size: 12, gap: 8 }

const params = new URLSearchParams(location.search)
const scene = params.get('demo') ?? 'focus'
const state = params.get('state') ?? 'other'
const dialog = params.get('dialog')

const mock = createMockPlatform()
;(mock.capabilities as { windowControlsInset: number }).windowControlsInset = MACOS_CONTROLS_INSET
window.__mock = mock
window.__store = useStore
const calls: string[] = []
;(window as unknown as { __shellCalls: string[] }).__shellCalls = calls

const newer = {
  commit: '53b9cf7',
  version: '0.1.0-beta.7',
  bundlePath: '/Users/someone/Downloads/Centralu 0.1.0-beta.7/Centralu.app',
}
const older = { commit: '2ffcaec5', version: '0.1.0-beta.6', bundlePath: '/Applications/Centralu.app' }
const tooLong = 'could not pass the state on: Message too long (os error 40)'

/** What the keeper would report in each state, as the shell hands it to the window */
function reported(): HostBuild {
  const base = { mode: 'keeper' as const, app: newer, keeper: older, keeperSameBuild: false, keepsAgents: true, busy: true }
  switch (state) {
    case 'older':
      return { ...base, app: older, host: newer, keeper: newer, sameBuild: false, keeperSameBuild: false }
    case 'progress':
      return { ...base, host: older, sameBuild: false, swap: { phase: 'starting', target: newer, from: older, startedAt: 1 } }
    case 'failed':
      return {
        ...base,
        host: older,
        sameBuild: false,
        swap: {
          phase: 'failed',
          target: newer,
          from: older,
          message: 'the new build did not pass its start check: no answer within 60s',
          startedAt: 1,
        },
      }
    case 'keeper-later':
      return {
        ...base,
        host: newer,
        sameBuild: true,
        swap: {
          phase: 'failed',
          target: newer,
          from: newer,
          message: `could not hand over to the new build's keeper: ${tooLong}`,
          keeperMessage: tooLong,
          startedAt: 2,
        },
      }
    case 'shell':
      return {
        ...base,
        host: newer,
        keeper: newer,
        sameBuild: true,
        keeperSameBuild: true,
        shell: {
          started: false,
          reason: 'content',
          message:
            'the content at /Applications/Centralu.app/Contents/Resources/content is not what the project signed: bad signature',
          notify: true,
          shellVersion: 1,
        },
      }
    case 'keeper-later-first':
      return {
        ...base,
        host: newer,
        sameBuild: true,
        swap: { phase: 'done', target: newer, from: older, keeperMessage: tooLong, startedAt: 1 },
      }
    default:
      return { ...base, host: older, sameBuild: false }
  }
}

function Banner() {
  const [build] = useState(reported)
  const [dismissed, setDismissed] = useState(false)
  const [dismissedSwap, setDismissedSwap] = useState<number | null>(null)
  const [dismissedShell, setDismissedShell] = useState(false)
  const [askRestart, setAskRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const bar = buildBar({ build, dismissed, dismissedSwap, dismissedShell })
  return (
    <>
      <BuildBarView
        build={build}
        bar={bar}
        error={null}
        restarting={restarting}
        onSwitch={() => calls.push('switch_host_build')}
        onDismiss={() => {
          if (bar.kind === 'shell') return setDismissedShell(true)
          if (build.swap) setDismissedSwap(build.swap.startedAt)
          setDismissed(true)
        }}
        onRestart={() => setAskRestart(true)}
      />
      {askRestart && (
        <RestartKeeperDialog
          onCancel={() => setAskRestart(false)}
          onConfirm={() => {
            setAskRestart(false)
            setRestarting(true)
            calls.push('restart_keeper')
          }}
        />
      )}
    </>
  )
}

function Quit() {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <QuitDialog
      background={params.get('background') === 'on'}
      strays={[]}
      alsoStop={false}
      error={null}
      onAlsoStop={() => {}}
      onCancel={() => setOpen(false)}
      onQuit={(completely) => {
        // What main.tsx's quit() runs: the keeper's stop, or the plain quit
        calls.push(completely ? 'quit_and_stop_agents' : 'quit_app')
        setOpen(false)
      }}
    />
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
      <App platform={mock} banner={dialog === 'quit' ? null : <Banner />} />
      {dialog === 'quit' && <Quit />}
      <TrafficLights />
    </>,
  )
})()
