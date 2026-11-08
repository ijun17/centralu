import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, useStore } from '@cc/ui'
import { createMockPlatform } from '@cc/platform/mock'
import { isDemoScene, seedDemo } from '@cc/platform/mock/demo'
import type { ShellHostBuild } from '@cc/platform/tauri'
import { buildBar, restartPlan } from '../../../../packages/platform/src/tauri/switch-plan.js'
import { BuildBarView, RestartKeeperDialog } from '../../../desktop/src/build-bar.js'
import { QuitDialog } from '../../../desktop/src/quit-dialog.js'
import '../../../../packages/ui/src/styles/index.css'

/**
 * A test rig for the desktop shell's own surfaces (#326, #387, exclusively for
 * e2e/shell-banner*.spec.ts, e2e/quit-dialog.spec.ts and e2e/desktop-dialog-layers.spec.ts).
 *
 * The keeper's build bar and the quit question only exist inside Tauri. So this stands the whole
 * App up on the mock, the way the browser entry does, and draws **the desktop's own components**
 * (apps/desktop/src/build-bar.tsx, quit-dialog.tsx) with a made-up `ShellHostBuild`, decided by the same
 * `buildBar` the desktop calls. What the buttons would do in the app is recorded in
 * `window.__shellCalls` instead.
 *
 * The mock reports no window controls (a browser has none), so this one says 86px, what
 * `window_controls_inset` returns on macOS, and draws three dots where trafficLightPosition puts
 * the traffic lights. The dots are inert (pointer-events: none) and only make a screenshot
 * readable; the spec reads the same position from tauri.conf.json to measure against.
 *
 * Query: `?demo=focus|grid` picks the scene; `?state=` the keeper's report:
 *   - `other`: the host and the keeper are of another build, a keeper that stops for an update, with something running
 *     (the restart into this build is offered, behind a question)
 *   - `earlier`: the same with a keeper of an earlier build, which gets a plain stop
 *   - `idle`: the same with nothing running (the restart goes without a question)
 *   - `older`: this window is an older build than the host and the keeper (#352: a backed-up
 *     app opened while a newer one runs; the restart back is offered, by hand only)
 *   - `shell`: everything on this build, but a release started its keeper without the permission
 *     shell (thin-shell plan §6), which refused the content
 * `?dialog=quit&background=on|off|serve` (`serve`: the window runs on the computer's `centralu serve` host, #1466; `&running=n`: sessions in a turn) opens the quit question instead; `?dialog=restart` the
 * restart question (e2e/desktop-dialog-layers.spec.ts).
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

/** What the keeper would report in each state, as the shell hands it to the window */
function reported(): ShellHostBuild {
  const base = { mode: 'keeper' as const, app: newer, host: older, keeper: older, sameBuild: false, keeperSameBuild: false, stopsForUpdate: true, busy: true }
  switch (state) {
    case 'older':
      return { ...base, app: older, host: newer, keeper: newer }
    case 'earlier':
      return { ...base, stopsForUpdate: false }
    case 'idle':
      return { ...base, busy: false }
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
    default:
      return base
  }
}

/** What main.tsx does with the bar, with the keeper's request recorded instead of sent */
function Banner() {
  const [build] = useState(reported)
  const [dismissed, setDismissed] = useState(false)
  const [dismissedShell, setDismissedShell] = useState(false)
  const [askRestart, setAskRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const bar = buildBar({ build, dismissed, dismissedShell })
  const plan = restartPlan(build)
  const restart = () => {
    setRestarting(true)
    calls.push('restart_keeper')
  }
  return (
    <>
      <BuildBarView
        build={build}
        bar={bar}
        error={null}
        restarting={restarting}
        onRestart={() => (plan.confirm ? setAskRestart(true) : restart())}
        onDismiss={() => (bar.kind === 'shell' ? setDismissedShell(true) : setDismissed(true))}
      />
      {askRestart && (
        <RestartKeeperDialog
          loses={plan.loses}
          onCancel={() => setAskRestart(false)}
          onConfirm={() => {
            setAskRestart(false)
            restart()
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
      serve={params.get('background') === 'serve'}
      strays={[]}
      straysError={params.get('strays') === 'unknown' ? 'The keeper could not say which processes it holds for this host, so leftover processes cannot be told apart; try again' : null}
      alsoStop={false}
      error={null}
      running={Number(params.get('running') ?? 0)}
      onAlsoStop={() => {}}
      onCancel={() => setOpen(false)}
      onKeepRunning={() => {
        // What main.tsx's keepRunning() runs: background mode on, then the plain quit
        calls.push('set_background_mode', 'quit_app')
        setOpen(false)
      }}
      onQuit={(completely) => {
        // What main.tsx's quit() runs: the keeper's stop, or the plain quit
        calls.push(completely ? 'quit_and_stop_agents' : 'quit_app')
        setOpen(false)
      }}
    />
  )
}

/** The desktop's restart question, drawn alone; a press outside or a button closes it, as in the app */
function AskRestart() {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <RestartKeeperDialog
      loses={restartPlan({ busy: true, stopsForUpdate: true }).loses}
      onCancel={() => setOpen(false)}
      onConfirm={() => {
        calls.push('restart_keeper')
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
      <App platform={mock} banner={dialog ? null : <Banner />} />
      {dialog === 'quit' && <Quit />}
      {dialog === 'restart' && <AskRestart />}
      <TrafficLights />
    </>,
  )
})()
