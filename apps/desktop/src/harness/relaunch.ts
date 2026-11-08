import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import type { ShellHostBuild } from '@cc/platform/tauri'

// Only the shell boundary is mocked: main.tsx boots the real Tauri platform and DesktopRoot.
// No host is started and no real data or OS APIs are used.
// A window of a newer build attached to a keeper of an older one, as after an update applied by hand (e2e/relaunch.spec.ts)
let build: ShellHostBuild = {
  mode: 'keeper', sameBuild: false, keeperSameBuild: false, stopsForUpdate: true, busy: true,
  app: { commit: 'new', version: `0.1.0-beta.${20}` },
  host: { commit: 'old', version: `0.1.0-beta.${19}` },
  keeper: { commit: 'old', version: `0.1.0-beta.${19}` },
}
const params = new URLSearchParams(location.search)
if (params.get('busy') === 'no') build.busy = false
if (params.get('keeper') === 'earlier') build.stopsForUpdate = false
/** The restart requests the window sent */
const calls: string[] = []
/** Every command the window asked the shell, in order */
const asked: string[] = []
let requestError: string | null = null
const report = async (patch: Partial<ShellHostBuild>) => {
  build = { ...build, ...patch }
  await emit('host-build', build)
}
Object.assign(window, { __relaunch: {
  calls, asked, report,
  rejectRequest: (message: string) => { requestError = message },
} })
mockWindows('main')
mockIPC(async (cmd) => {
  asked.push(cmd)
  if (cmd === 'host_info') return { port: 1, token: 'test-only' }
  if (cmd === 'host_build') return build
  if (cmd === 'host_error') return null
  if (cmd === 'window_controls_inset') return 0
  if (cmd === 'shortcut_keys') return { mod: 'Ctrl', alt: 'Alt', join: '+' }
  if (cmd === 'file_manager_name') return 'file manager'
  if (cmd === 'background_mode') return false
  if (cmd === 'plugin:global-shortcut|is_registered') return true
  if (cmd === 'restart_keeper') {
    calls.push(cmd)
    if (requestError) throw new Error(requestError)
  }
  return null
}, { shouldMockEvents: true })

void import('../main.js')
