import { flagSetting, type SettingAccess } from './dev-services/store/settings.js'
import { isInside, samePath, type OsFamily } from './os/rules.js'

export const AUTO_UPDATE_CHECK_KEY = 'updates.auto'
export const AUTO_APPLY_UPDATES_KEY = 'updates.autoApply'

/**
 * The stored update switches (#43, #352) and what each reads as for a person who never chose: Settings shows them as one
 * "Automatic updates" setting, checking (`auto`) and installing when idle (`autoApply`). Both are on by default; a stored `'false'` stays
 * off (`flagSetting`), and so does installing for someone who turned checking off before the two were one setting, since their
 * Check now would otherwise install by itself. `installByDefault` false keeps installing off unless turned on, on every host that is
 * not the person's desktop app (`installsByDefault`); checking stays on there (read-only)
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

export type InstallFacts = {
  build: string
  startedBy: 'app' | 'keeper' | 'serve' | null
  bundlePath: string | null
  installedCopy: string
  env: Record<string, string | undefined>
  family: OsFamily
}

/**
 * Whether this host installs updates by itself when the person never chose: only the person's desktop app, which is what Settings'
 * "Automatic updates" is about: a bundled build the window started (`startedBy` app: Windows, Linux) or the keeper runs from the
 * installed app (`bundlePath` is `installedCopy`: macOS). Never a `centralu serve` host, whose version the hub keeps (`machines.update`,
 * under `<data>/remote`): installing by itself would race it and split the versions. Never a host from source or one a script or test
 * harness started (no `startedBy`, a build-output or debug bundle, `CI` set): its data folder is temporary, and it must not install
 * the published package globally on the machine running it
 */
export function installsByDefault(f: InstallFacts): boolean {
  if (f.build === 'dev' || inCi(f.env)) return false
  if (f.startedBy === 'app') return true
  return f.startedBy === 'keeper' && f.bundlePath !== null && samePath(f.bundlePath, f.installedCopy, f.family)
}

/**
 * Whether this host brings the installed desktop copy (`installedCopyPath`) up to its own version (#1736, `UpdateService.followHost`):
 * only a `centralu serve` host a linked hub installed, a release, not under CI. The hub updates such a machine with the host-only
 * package (`machines.update`), which has no desktop executable, so a window running on this host (`Host::Serve`) would keep its
 * executable for good. The machine's own "Automatic updates" switch is not read, as the hub's update of the host does not read it
 * (`LinkedMachine.followsHub`). A host from the npm package is left out: refreshing the package would replace the files it runs
 * from. Never where the swap may raise an OS prompt (`copySwapMayPrompt`: macOS). `hubInstall` is where a hub installs
 * Centralu in this data folder (`<data>/remote`, links/install.ts)
 */
export function copyFollowsHost(f: Pick<InstallFacts, 'build' | 'startedBy' | 'env' | 'family'> & { entry: string | undefined; hubInstall: string; swapMayPrompt: boolean }): boolean {
  if (f.build === 'dev' || inCi(f.env) || f.startedBy !== 'serve' || !f.entry || f.swapMayPrompt) return false
  return isInside(f.hubInstall, f.entry, f.family) && !samePath(f.hubInstall, f.entry, f.family)
}

function inCi(env: Record<string, string | undefined>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI.toLowerCase() !== 'false'
}
