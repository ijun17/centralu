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
 * The desktop's own build bar and quit question (they exist only inside Tauri) on the full App over the mock, for
 * e2e/shell-banner*, quit-dialog and desktop-dialog-layers specs; button presses land in `window.__shellCalls`. Dev only.
 */

// macOS's `window_controls_inset`; the dots sit where trafficLightPosition puts the lights, inert, for screenshots
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

/**
 * `?state=`: `other` a keeper of another build that stops for an update, something running (restart asks first);
 * `earlier` its keeper is of an earlier build (a plain stop); `idle` nothing running; `older` this window is older than
 * host and keeper (#352, restart back by hand); `shell` the permission shell refused the content (thin-shell plan §6).
 * `?dialog=quit&background=on|off|serve[&running=n]` (`serve`: a `centralu serve` host, #1466) or `?dialog=restart`.
 */
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

/** As main.tsx, with the keeper's request recorded instead of sent */
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
