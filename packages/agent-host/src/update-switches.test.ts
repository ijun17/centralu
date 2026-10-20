import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './dev-services/store.js'
import { AUTO_APPLY_UPDATES_KEY, AUTO_UPDATE_CHECK_KEY, installsByDefault, updateSwitches, type InstallFacts } from './update-switches.js'

/**
 * "Automatic updates" (owner decision 2026-10-20): checking and installing-and-applying-when-idle are one setting, on for
 * everyone who never chose. A person who turned either off before keeps it off.
 */
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})
function settings(rows: Record<string, string> = {}) {
  const store = new Store()
  stores.push(store)
  for (const [k, v] of Object.entries(rows)) store.settings.setAppSetting(k, v)
  return store.settings
}
const read = (rows: Record<string, string>, installByDefault = true) => {
  const s = updateSwitches(settings(rows), { installByDefault })
  return [s.auto.read(), s.autoApply.read()]
}

describe('the stored update switches', () => {
  it('are both on for a person who never chose', () => {
    expect(read({})).toEqual([true, true])
  })

  it('stay off for a person who turned either off before, and on for one who turned them on', () => {
    expect(read({ [AUTO_APPLY_UPDATES_KEY]: 'false' })).toEqual([true, false])
    expect(read({ [AUTO_UPDATE_CHECK_KEY]: 'false', [AUTO_APPLY_UPDATES_KEY]: 'false' })).toEqual([false, false])
    expect(read({ [AUTO_UPDATE_CHECK_KEY]: 'false', [AUTO_APPLY_UPDATES_KEY]: 'true' })).toEqual([false, true])
    expect(read({ [AUTO_APPLY_UPDATES_KEY]: 'true' }, false)).toEqual([true, true])
  })

  // Their Check now would otherwise install by itself, where it only informed before (review of this change)
  it('keep installing off for a person who turned checking off and never chose installing', () => {
    expect(read({ [AUTO_UPDATE_CHECK_KEY]: 'false' })).toEqual([false, false])
  })

  it('write what the person chooses, read back after a restart', () => {
    const rows = settings()
    updateSwitches(rows, { installByDefault: true }).autoApply.write(false)
    expect(updateSwitches(rows, { installByDefault: true }).autoApply.read()).toBe(false)
    expect(rows.appSetting(AUTO_APPLY_UPDATES_KEY)).toBe('false')
  })

  // A checkout, a test or an e2e host on a temporary data folder must not install the published package globally by itself
  it('keep installing off where a host does not install by default, unless turned on; checking on as before', () => {
    expect(read({}, false)).toEqual([true, false])
  })
})

describe('which hosts install by default', () => {
  const app = '/Applications/Centralu.app'
  const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({ build: '1a2b3c4', startedBy: 'app', bundlePath: null, installedCopy: app, env: {}, ...over })

  it("the person's desktop app: a bundled build the window started, or the keeper runs from the installed app", () => {
    expect(installsByDefault(facts({ startedBy: 'app' }))).toBe(true)
    expect(installsByDefault(facts({ startedBy: 'keeper', bundlePath: app }))).toBe(true)
    expect(installsByDefault(facts({ startedBy: 'keeper', bundlePath: `${app}/` }))).toBe(true)
  })

  // RVRH review: a linked machine's host is the hub's to keep at a version (machines.update, the managed install)
  it('never a centralu serve host, whoever asked for it', () => {
    expect(installsByDefault(facts({ startedBy: 'serve' }))).toBe(false)
    expect(installsByDefault(facts({ startedBy: 'serve', bundlePath: '/home/me/.centralu/remote/host' }))).toBe(false)
  })

  it('never a keeper running another bundle: a build output, a debug exe, an AppImage mount', () => {
    for (const bundlePath of ['/src/target/release/bundle/macos/Centralu.app', '/src/target/debug/centralu', '/tmp/.mount_CentraXX/usr/bin/centralu', null]) {
      expect(installsByDefault(facts({ startedBy: 'keeper', bundlePath })), String(bundlePath)).toBe(false)
    }
  })

  it('never a host from source, one nothing says started it (a script, a test), or one under CI', () => {
    expect(installsByDefault(facts({ build: 'dev' }))).toBe(false)
    expect(installsByDefault(facts({ startedBy: null }))).toBe(false)
    expect(installsByDefault(facts({ env: { CI: 'true' } }))).toBe(false)
    expect(installsByDefault(facts({ env: { CI: '1' } }))).toBe(false)
    // CI unset, empty or false is no harness
    for (const CI of [undefined, '', '0', 'false']) expect(installsByDefault(facts({ env: { CI } })), String(CI)).toBe(true)
  })
})
