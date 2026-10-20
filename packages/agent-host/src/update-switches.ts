import { flagSetting, type SettingAccess } from './dev-services/store/settings.js'

/** Where the two update switches live in the store's settings table */
export const AUTO_UPDATE_CHECK_KEY = 'updates.auto'
export const AUTO_APPLY_UPDATES_KEY = 'updates.autoApply'

/**
 * The stored update switches (#43, #352) and what each reads as for a person who never chose. Settings shows them as one
 * "Automatic updates" setting (owner decision 2026-10-20): checking (`auto`), and installing and applying when idle
 * (`autoApply`). Both are **on** for a person who never chose. A person who turned either off has `'false'` stored and
 * stays off, since a default only covers a row never written (`flagSetting`); and one who turned checking off before
 * installing was a part of the same setting keeps installing off too: otherwise their Check now would install by itself,
 * where it only informed before.
 *
 * `installByDefault` false keeps installing off unless it was turned on, for every host that is not the person's desktop
 * app (`installsByDefault`). Checking stays on there as before (read-only).
 */
export function updateSwitches(settings: SettingAccess, { installByDefault }: { installByDefault: boolean }) {
  const auto = flagSetting(settings, AUTO_UPDATE_CHECK_KEY, true)
  const stored = flagSetting(settings, AUTO_APPLY_UPDATES_KEY, false)
  return {
    auto,
    autoApply: {
      read: () => (settings.appSetting(AUTO_APPLY_UPDATES_KEY) === null ? installByDefault && auto.read() : stored.read()),
      write: stored.write,
    },
  }
}

/** What decides whether a host installs updates when nobody chose (`installsByDefault`) */
export type InstallFacts = {
  /** The bundled build id, or `dev` for a host run from source */
  build: string
  /** Who started it (`LaunchEnv.startedBy`): the window directly, the keeper, `centralu serve`, or nothing that says */
  startedBy: 'app' | 'keeper' | 'serve' | null
  /** The app bundle the keeper took this build from (`CC_HOST_SOURCE`'s `bundlePath`), when a keeper started it */
  bundlePath: string | null
  /** Where `centralu install` puts the desktop app on this OS (`installedCopyPath`) */
  installedCopy: string
  env: Record<string, string | undefined>
}

/**
 * Whether this host installs updates by itself when the person never chose (owner decision 2026-10-20): only the person's
 * desktop app, which is what Settings' "Automatic updates" is about.
 *
 *   window   a bundled build the desktop window started itself (`CC_STARTED_BY=app`: Windows, Linux)
 *   keeper   a bundled build the keeper runs from the installed app (`bundlePath` is `installedCopy`: macOS)
 *
 * Never a `centralu serve` host: on a linked machine the hub keeps its version (`machines.update`, the managed install
 * under `<data>/remote`), and one installing by itself would race it and leave the two versions apart; the window's own
 * `serve --window` host is a machine with serve installed, so the same. Never a host from source, nor one a script or test
 * harness started (no `startedBy`, a keeper running a build-output or debug bundle, `CI` set): its data folder is a
 * temporary one, and it must not install the published package globally on the machine running it.
 */
export function installsByDefault(f: InstallFacts): boolean {
  const ci = f.env.CI !== undefined && f.env.CI !== '' && f.env.CI !== '0' && f.env.CI.toLowerCase() !== 'false'
  if (f.build === 'dev' || ci) return false
  if (f.startedBy === 'app') return true
  return f.startedBy === 'keeper' && f.bundlePath !== null && samePath(f.bundlePath, f.installedCopy)
}

/** Two paths the same once trailing separators are dropped */
function samePath(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  return trim(a) === trim(b)
}
