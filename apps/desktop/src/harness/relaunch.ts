import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import type { ShellHostBuild } from '@cc/platform/tauri'

// Only the shell boundary is mocked: main.tsx boots the real Tauri platform and DesktopRoot.
// No host is started and no real data or OS APIs are used.
let build: ShellHostBuild = {
  mode: 'keeper', relaunched: true, sameBuild: false, keeperSameBuild: false,
  busy: false, keepsAgents: true,
  app: { commit: 'new', version: `0.1.0-beta.${20}` },
  host: { commit: 'old', version: `0.1.0-beta.${19}` },
  keeper: { commit: 'old', version: `0.1.0-beta.${19}` },
}
const params = new URLSearchParams(location.search)
const scenario = params.get('scenario')
const prior = params.get('prior')
if (prior === 'done' || prior === 'failed') {
  build.swap = { phase: prior, target: build.host!, startedAt: 0, message: 'Previous swap failed' }
}
let timedSwitch: { finalBeforeTimeout?: 'done' | 'failed' } | null = null
const calls: string[] = []
let requestError: string | null = null
const report = async (patch: Partial<ShellHostBuild>) => {
  build = { ...build, ...patch }
  await emit('host-build', build)
}
Object.assign(window, { __relaunch: {
  calls, report,
  rejectRequest: (message: string) => { requestError = message },
  timeoutNextSwitch: (finalBeforeTimeout?: 'done' | 'failed') => { timedSwitch = { finalBeforeTimeout } },
} })
mockWindows('main')
mockIPC(async (cmd) => {
  if (cmd === 'host_info') return { port: 1, token: 'test-only' }
  if (cmd === 'host_build') return build
  if (cmd === 'host_error') return null
  if (cmd === 'window_controls_inset') return 0
  if (cmd === 'shortcut_keys') return { mod: 'Ctrl', alt: 'Alt', join: '+' }
  if (cmd === 'file_manager_name') return 'file manager'
  if (cmd === 'background_mode') return false
  if (cmd === 'plugin:global-shortcut|is_registered') return true
  if (cmd === 'switch_host_build') {
    calls.push(cmd)
    if (timedSwitch) {
      const { finalBeforeTimeout } = timedSwitch
      timedSwitch = null
      await report({ swap: { phase: 'draining', target: build.app!, startedAt: 2 } })
      if (finalBeforeTimeout) {
        await report({ swap: { phase: finalBeforeTimeout, target: build.app!, startedAt: 2,
          message: 'New swap failed after drain' } })
      }
      await new Promise((_, reject) => setTimeout(() => reject(new Error('the keeper did not answer: operation timed out')), 10_000))
      return null
    }
    if (requestError) throw new Error(requestError)
    if (scenario === 'timeout-before-swap') return null
    if (scenario === 'rejected') throw new Error('Keeper refused the handoff')
    await report({ swap: { phase: scenario === 'failed' ? 'failed' : 'draining',
      target: build.app!, startedAt: 1, ...(scenario === 'failed' ? { message: 'New host failed its start check' } : {}) } })
  }
  if (cmd === 'restart_keeper') {
    calls.push(cmd)
    if (requestError) throw new Error(requestError)
  }
  return null
}, { shouldMockEvents: true })

void import('../main.js')
