import { describe, expect, it } from 'vitest'
import {
  COMPLETELY_STOPS,
  RESTART_COMPLETELY_LOSES,
  UPDATE_STOP_LOSES,
  autoRestart,
  buildBar,
  isNewerBuild,
  olderBuildText,
  restartPlan,
  shellBarText,
  type AutoRestartInput,
  type Build,
  type BuildBarInput,
  type ShellStart,
} from './switch-plan.js'

/** Release builds as the keeper records them: version from the app, `builtAt` from bundle-info.json */
const beta10: Build = { commit: '2ffcaec5', version: '0.1.0-beta.10', builtAt: '2026-10-01T09:00:00.000Z' }
const beta11: Build = { commit: '53b9cf7', version: '0.1.0-beta.11', builtAt: '2026-10-06T09:00:00.000Z' }

describe('which of two builds is newer, for restarting by itself only forward (#352)', () => {
  it('orders by app version, prereleases included', () => {
    expect(isNewerBuild(beta11, beta10)).toBe(true)
    expect(isNewerBuild(beta10, beta11)).toBe(false)
    // Numerically, not as text: beta.10 is newer than beta.9
    expect(isNewerBuild({ commit: 'a', version: '0.1.0-beta.10' }, { commit: 'b', version: '0.1.0-beta.9' })).toBe(true)
    // A release outranks its prereleases, and a higher core outranks any prerelease
    expect(isNewerBuild({ commit: 'a', version: '0.1.0' }, beta11)).toBe(true)
    expect(isNewerBuild(beta11, { commit: 'a', version: '0.1.0' })).toBe(false)
    expect(isNewerBuild({ commit: 'a', version: '0.2.0-beta.1' }, { commit: 'b', version: '0.1.0' })).toBe(true)
  })

  it('the version decides, whatever the build times say', () => {
    expect(isNewerBuild({ ...beta11, builtAt: '2020-01-01T00:00:00Z' }, beta10)).toBe(true)
    expect(isNewerBuild(beta10, { ...beta11, builtAt: '2020-01-01T00:00:00Z' })).toBe(false)
  })

  it('on equal versions, the later build time is newer (a local build of the same version)', () => {
    const later = { ...beta10, commit: 'abc1234-dirty', builtAt: '2026-10-02T09:00:00.000Z' }
    expect(isNewerBuild(later, beta10)).toBe(true)
    expect(isNewerBuild(beta10, later)).toBe(false)
    // The keeper's fallback when bundle-info.json has no builtAt: whole seconds since the epoch
    const fallback = { ...beta10, builtAt: String(Date.parse('2026-10-03T00:00:00Z') / 1000) }
    expect(isNewerBuild(fallback, beta10)).toBe(true)
    expect(isNewerBuild(beta10, fallback)).toBe(false)
    // The same build is not newer than itself
    expect(isNewerBuild(beta10, { ...beta10 })).toBe(false)
  })

  it('what cannot be ordered is never newer, either way', () => {
    const cases: [Build | undefined, Build | undefined][] = [
      // A side is missing
      [beta11, undefined],
      [undefined, beta10],
      // No version
      [{ commit: 'abc' }, beta10],
      [beta11, { commit: 'abc' }],
      // A version that is not semver
      [{ ...beta11, version: 'nightly' }, beta10],
      [beta11, { ...beta10, version: '' }],
      // Equal versions without both build times, or with one that is not a time
      [beta10, { ...beta10, builtAt: undefined }],
      [{ ...beta10, builtAt: undefined }, beta10],
      [{ ...beta10, builtAt: 'later' }, beta10],
      // A host run from source (`BuildSource::dev()`), even with a version
      [{ commit: 'dev' }, beta10],
      [beta11, { commit: 'dev' }],
      [{ commit: 'dev', version: '9.9.9' }, beta10],
    ]
    for (const [a, b] of cases) {
      expect(isNewerBuild(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false)
    }
  })
})

describe('what a restart into this build costs (#1895 step 4, PR 3)', () => {
  it('restarts without asking when nothing is running, and asks when something is or nobody knows', () => {
    expect(restartPlan({ busy: false, stopsForUpdate: true }).confirm).toBe(false)
    expect(restartPlan({ busy: true, stopsForUpdate: true }).confirm).toBe(true)
    expect(restartPlan({ stopsForUpdate: true }).confirm).toBe(true)
    expect(restartPlan({}).confirm).toBe(true)
  })

  /* A keeper whose host is down reports idle and cannot stop for an update; one of beta.48 still holds agents then (review) */
  it('a plain stop always asks, even from a keeper that reports itself idle', () => {
    expect(restartPlan({ busy: false }).confirm).toBe(true)
    expect(restartPlan({ busy: false, stopsForUpdate: false }).confirm).toBe(true)
  })

  it('a keeper that stops for an update: turns stop and go on, terminals and commands start again', () => {
    const { loses } = restartPlan({ busy: true, stopsForUpdate: true })
    expect(loses).toBe(UPDATE_STOP_LOSES)
    expect(loses).toContain('Running turns stop and go on once this build is up')
    expect(loses).not.toContain('keep running')
  })

  it('an earlier keeper, or one that cannot be told: what "Quit completely" stops', () => {
    expect(restartPlan({ busy: true, stopsForUpdate: false }).loses).toBe(RESTART_COMPLETELY_LOSES)
    expect(restartPlan({ busy: true }).loses).toBe(RESTART_COMPLETELY_LOSES)
    expect(RESTART_COMPLETELY_LOSES).toContain(COMPLETELY_STOPS)
    expect(COMPLETELY_STOPS).toBe('Also stops agents, terminals and running commands.')
  })
})

/** The automatic mode restarting into this build by itself (#352) */
describe('restarting by itself with automatic updates on (#352)', () => {
  const idle: AutoRestartInput = {
    build: { app: beta11, host: beta10, keeper: beta10, busy: false, stopsForUpdate: true, sameBuild: false, keeperSameBuild: false },
    autoApply: true,
    tried: false,
    dismissed: false,
  }

  it('restarts without a click when nothing is running, the keeper alone behind included', () => {
    expect(autoRestart(idle)).toBe(true)
    expect(autoRestart({ ...idle, build: { ...idle.build, host: beta11, sameBuild: true } })).toBe(true)
  })

  it('never while something runs or nobody knows, never with the setting off, never twice, never after "Not now"', () => {
    expect(autoRestart({ ...idle, build: { ...idle.build, busy: true } })).toBe(false)
    expect(autoRestart({ ...idle, build: { ...idle.build, busy: undefined } })).toBe(false)
    expect(autoRestart({ ...idle, autoApply: false })).toBe(false)
    expect(autoRestart({ ...idle, tried: true })).toBe(false)
    expect(autoRestart({ ...idle, dismissed: true })).toBe(false)
    expect(autoRestart({ ...idle, build: { ...idle.build, sameBuild: true, keeperSameBuild: true } })).toBe(false)
  })

  /* Review: a keeper whose host is down reports idle and no stopsForUpdate; a beta.48 one still holds agents then */
  it('never a plain stop: a keeper that cannot stop for an update, or does not say, is left to the button', () => {
    expect(autoRestart({ ...idle, build: { ...idle.build, stopsForUpdate: false } })).toBe(false)
    expect(autoRestart({ ...idle, build: { ...idle.build, stopsForUpdate: undefined } })).toBe(false)
  })

  /*
   * Opening an older build's window (a backed-up beta.10 app while beta.11 runs) must not quietly downgrade the keeper and
   * the host. The bar still offers the restart by hand.
   */
  it('only forward: a window of an older build never restarts by itself', () => {
    expect(autoRestart({ ...idle, build: { ...idle.build, app: beta10, host: beta11, keeper: beta11 } })).toBe(false)
    // A keeper alone behind, of a newer build than this window, is not moved back either
    expect(autoRestart({ ...idle, build: { ...idle.build, app: beta10, host: beta10, keeper: beta11, sameBuild: true } })).toBe(false)
    // Nor is a newer host when only the keeper is older than this window
    expect(autoRestart({ ...idle, build: { ...idle.build, app: beta10, host: beta11, keeper: { ...beta10, version: '0.1.0-beta.9' } } })).toBe(false)
  })

  it('a window whose build cannot be ordered against the running one leaves it to the bar', () => {
    expect(autoRestart({ ...idle, build: { ...idle.build, host: { commit: '2ffcaec5' }, keeper: { commit: '2ffcaec5' } } })).toBe(false)
    expect(autoRestart({ ...idle, build: { ...idle.build, app: { commit: 'dev' } } })).toBe(false)
    expect(autoRestart({ ...idle, build: { ...idle.build, host: undefined } })).toBe(false)
    // The same version built twice: only the later one goes ahead by itself
    const rebuilt = { ...beta10, commit: 'abc1234-dirty', builtAt: '2026-10-02T09:00:00.000Z' }
    expect(autoRestart({ ...idle, build: { ...idle.build, app: rebuilt, host: beta10, keeper: beta10 } })).toBe(true)
    expect(autoRestart({ ...idle, build: { ...idle.build, app: beta10, host: rebuilt, keeper: rebuilt } })).toBe(false)
  })
})

describe('the bar for a window of an older build (#352)', () => {
  const input = (build: BuildBarInput['build']): BuildBarInput => ({ build, dismissed: false })

  it('says the window is the older build, so the restart it offers goes back', () => {
    const bar = buildBar(input({ mode: 'keeper', app: beta10, host: beta11, keeper: beta11, sameBuild: false, keeperSameBuild: false }))
    expect(bar).toEqual({ kind: 'other', who: 'host', older: true })
    expect(
      buildBar(input({ mode: 'keeper', app: beta10, host: beta10, keeper: beta11, sameBuild: true, keeperSameBuild: false })),
    ).toEqual({ kind: 'other', who: 'keeper', older: true })
    expect(olderBuildText(beta10, beta11)).toBe(
      'This window is an older build (0.1.0-beta.10, 2ffcaec5) than the one running (0.1.0-beta.11, 53b9cf7).',
    )
  })

  it('a newer window, or one that cannot be ordered, gets the bar as before', () => {
    const plain = { kind: 'other', who: 'host' }
    expect(buildBar(input({ mode: 'keeper', app: beta11, host: beta10, sameBuild: false }))).toEqual(plain)
    expect(buildBar(input({ mode: 'keeper', app: beta10, host: { commit: 'x' }, sameBuild: false }))).toEqual(plain)
  })
})

describe('the build bar otherwise (#280)', () => {
  const app = { commit: 'new' }
  const host = { mode: 'keeper' as const, app, sameBuild: false, keeperSameBuild: false }
  const input = (build: BuildBarInput['build'], over: Partial<BuildBarInput> = {}): BuildBarInput => ({ build, dismissed: false, ...over })

  it('offers the restart for a host or a keeper of another build, a keeper that says no build of its own included (#461)', () => {
    expect(buildBar(input(host))).toEqual({ kind: 'other', who: 'host' })
    expect(buildBar(input({ ...host, sameBuild: true }))).toEqual({ kind: 'other', who: 'keeper' })
  })

  it('nothing in direct mode, once everything is on this build, or after "Not now"', () => {
    expect(buildBar(input({ ...host, mode: 'direct' }))).toEqual({ kind: 'none' })
    expect(buildBar(input({ mode: 'keeper', app, sameBuild: true, keeperSameBuild: true }))).toEqual({ kind: 'none' })
    expect(buildBar(input(host, { dismissed: true }))).toEqual({ kind: 'none' })
  })
})

describe('a keeper started without the permission shell (docs/plans/thin-shell.md §6)', () => {
  const app = { commit: 'new' }
  const onThisBuild = { mode: 'keeper' as const, app, sameBuild: true, keeperSameBuild: true }
  const refused = (over: Partial<ShellStart> = {}): ShellStart => ({
    started: false,
    reason: 'content',
    message: 'the content at /Applications/Centralu.app/Contents/Resources/content is not what the project signed: bad signature',
    notify: true,
    shellVersion: 1,
    ...over,
  })
  const input = (shell: ShellStart | undefined, over: Partial<BuildBarInput> = {}): BuildBarInput => ({
    build: { ...onThisBuild, shell },
    dismissed: false,
    ...over,
  })

  it('a release says so, what it costs, and the reason in a few words; the full reason on hover', () => {
    expect(buildBar(input(refused()))).toEqual({
      kind: 'shell',
      text: "Agents started without the permission shell (this build's signed content did not verify). They work, but macOS may ask for permissions again after an update.",
      detail: 'the content at /Applications/Centralu.app/Contents/Resources/content is not what the project signed: bad signature',
    })
  })

  it('every reason has words, and an unknown one still reads', () => {
    for (const reason of ['content', 'shell-too-old', 'downgrade', 'copy', 'keeper-start', 'keeper-exited', 'keeper-timeout', 'install', 'open', 'no-report']) {
      expect(shellBarText(reason), reason).not.toContain('did not start it')
    }
    expect(shellBarText('something-new')).toContain('the permission shell did not start it')
    expect(shellBarText(undefined)).toContain('the permission shell did not start it')
  })

  it('nothing for a start through the shell, a local build, or once dismissed', () => {
    expect(buildBar(input({ started: true, notify: true, shellVersion: 1 }))).toEqual({ kind: 'none' })
    expect(buildBar(input(refused({ reason: 'unpinned', notify: false })))).toEqual({ kind: 'none' })
    expect(buildBar(input(refused({ notify: false })))).toEqual({ kind: 'none' })
    expect(buildBar(input(refused(), { dismissedShell: true }))).toEqual({ kind: 'none' })
    expect(buildBar(input(undefined))).toEqual({ kind: 'none' })
  })

  it('a restart to offer comes first', () => {
    const behind = { ...input(refused()), build: { ...onThisBuild, sameBuild: false, shell: refused() } }
    expect(buildBar(behind).kind).toBe('other')
  })
})
