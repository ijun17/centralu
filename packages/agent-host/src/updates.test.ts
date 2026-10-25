import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { APP_VERSION, type UpdateStatus } from '@cc/protocol'

/** The release this build is in these tests: a source tree carries the placeholder 0.0.0-dev (#1501), older than all */
const RELEASE = '0.1.0-beta.20'
import { installedCopyVersionSource } from './os.js'
import { resolveCommand } from './tool-launch.js'
import { UpdateService, hubUpdatesMachines, commandFor, failureDetail, installedCopyPath, readInstalledCopyVersion, runCommand, type LatestResult } from './updates.js'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { bundleVersionCommand, installedPaths } from '../../../packaging/npm/centralu/bin/platform.mjs'

/**
 * Checking for and installing app updates (issue #43).
 *
 * **None of these tests reach out to the registry or run `npm i -g`.** Both pass only through
 * injected seams, and that is the guarantee that this file cannot alter this machine.
 */
function make(
  opts: {
    fetchLatest?: (timeoutMs: number) => Promise<LatestResult>
    registry?: string | null
    run?: (file: string, args: string[]) => Promise<void>
    autoApply?: boolean
    installedCopy?: string | null
    installedCopyVersion?: (copy: string) => string | null
    wait?: (ms: number) => Promise<void>
    now?: () => number
    schedule?: (fn: () => void, ms: number) => () => void
    /** The version the build carries; RELEASE when not given, `null` for the build's own (`APP_VERSION`) */
    current?: string | null
    build?: string
  } = {},
) {
  const published: UpdateStatus[] = []
  const calls: [string, string[]][] = []
  const saved: boolean[] = []
  let registry = opts.registry ?? null
  let fetches = 0
  let now = 1000
  const svc = new UpdateService((s) => published.push(s), {
    ...(opts.current === null ? {} : { current: opts.current ?? RELEASE }),
    ...(opts.build === undefined ? {} : { build: opts.build }),
    fetchLatest: async (timeoutMs): Promise<LatestResult> => {
      fetches++
      if (opts.fetchLatest) return opts.fetchLatest(timeoutMs)
      return registry === null ? { ok: false, reason: 'Could not reach the registry' } : { ok: true, version: registry }
    },
    run: async (file, args) => {
      calls.push([file, args])
      await (opts.run?.(file, args) ?? Promise.resolve())
    },
    installedCopy: () => opts.installedCopy ?? null,
    installedCopyVersion: opts.installedCopyVersion ?? (() => null),
    readAutoApply: () => opts.autoApply ?? false,
    writeAutoApply: (enabled) => saved.push(enabled),
    wait: opts.wait,
    now: opts.now ?? (() => now),
    schedule: opts.schedule ?? (() => () => {}),
  })
  return {
    svc,
    published,
    calls,
    saved,
    elapse: (ms: number) => { now += ms },
    get fetches() {
      return fetches
    },
    offer: (v: string | null) => {
      registry = v
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Waits until state settles into shape — installation finishes after this returns */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('UpdateService', () => {
  describe('fresh install target (#635)', () => {
    it.each([false, true])('installs the newest of two releases in one pass (auto-apply=%s)', async (automatic) => {
      const h = make({ registry: '9999.0.1' })
      await h.svc.check(true)
      h.elapse(60_000)
      h.offer('9999.0.2')
      if (automatic) h.svc.setAutoApply(true)
      else h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.2']]])
      expect(h.published).toContainEqual(expect.objectContaining({ phase: 'updating', latest: '9999.0.2' }))
      h.svc.apply()
      await h.svc.check(true)
      await settle()
      expect(h.calls).toHaveLength(1)
    })

    it('reuses the successful check that just triggered auto-apply (#636 review)', async () => {
      const fetchLatest = vi.fn().mockResolvedValue({ ok: true, version: '9999.0.2' })
      const h = make({ autoApply: true, fetchLatest })
      await h.svc.check(false)
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(fetchLatest.mock.calls).toEqual([[3000]])
      expect(h.calls[0]?.[1]).toContain('centralu@9999.0.2')
    })

    it.each([0, 1, 30_000, 59_999, 60_000, 60_001, 120_000])('refreshes only when the successful check is at least one minute old: %s ms (#636 review)', async (age) => {
      const fetchLatest = vi.fn().mockResolvedValue({ ok: true, version: '9999.0.2' })
      const h = make({ fetchLatest })
      await h.svc.check(false)
      h.elapse(age)
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(fetchLatest.mock.calls).toEqual(age < 60_000 ? [[3000]] : [[3000], [8000]])
    })

    it('falls back visibly to the stored version when the refresh fails, including after npm retries', async () => {
      let attempts = 0
      const h = make({ registry: '9999.0.1', run: async () => {
        if (++attempts === 1) throw new Error('ETARGET')
      }, wait: async () => {} })
      await h.svc.check(true)
      h.elapse(60_000)
      h.offer(null)
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls.every(([, args]) => args.includes('centralu@9999.0.1'))).toBe(true)
      const notice = 'Could not refresh latest (Could not reach the registry); using previously checked 9999.0.1.'
      expect(h.svc.current().error).toBe(notice)
      expect(h.published).toContainEqual(expect.objectContaining({ phase: 'waiting_for_npm', error: expect.stringContaining(notice) }))
      expect(h.published).toContainEqual(expect.objectContaining({ phase: 'updating', error: notice }))
    })

    it.each(['9999.0.0', RELEASE, '0.0.1'])('keeps the stored newer release when a stale edge returns %s (#636 review)', async (fresh) => {
      const h = make({ registry: '9999.0.1' })
      await h.svc.check(true)
      h.elapse(60_000)
      h.offer(fresh)
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.1']]])
      expect(h.svc.current()).toMatchObject({ latest: '9999.0.1', newer: true })
    })

    it.each([false, true])('ordinary checks follow a dist-tag rollback (forced=%s, #636 rollback)', async (force) => {
      const h = make({ registry: '9999.0.1' })
      await h.svc.check(true)
      h.elapse(6 * 3600_000)
      h.offer(RELEASE)
      await h.svc.check(force)
      expect(h.svc.current()).toMatchObject({ latest: RELEASE, newer: false, phase: 'idle' })
      expect(h.calls).toEqual([])
    })

    it.each([60_000, 1800_000, 3599_999, 3600_000, 3600_001, 7200_000])('limits install-time stale-edge protection to a stored age of less than one hour: %s ms (#636 rollback)', async (age) => {
      const h = make({ registry: '9999.0.2' })
      await h.svc.check(true)
      h.elapse(age)
      h.offer('9999.0.1')
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      const target = age < 3600_000 ? '9999.0.2' : '9999.0.1'
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', `centralu@${target}`]]])
      expect(h.svc.current().latest).toBe(target)
    })

    it.each([RELEASE, '0.0.1'])('does not install when an old stored version is replaced by a fresh tag at %s (#636 rollback)', async (fresh) => {
      const h = make({ registry: '9999.0.1' })
      await h.svc.check(true)
      h.elapse(3600_001)
      h.offer(fresh)
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('idle'))
      expect(h.svc.current()).toMatchObject({ latest: fresh, newer: false })
      expect(h.calls).toEqual([])
    })

    it('retaining a newer install target does not renew when it was actually seen (#636 rollback)', async () => {
      let fails = true
      const h = make({ registry: '9999.0.2', run: async () => {
        if (fails) throw new Error('EACCES')
      } })
      await h.svc.check(true)
      const checkedAt = h.svc.current().checkedAt
      h.elapse(3599_999)
      h.offer('9999.0.1')
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
      expect(h.svc.current().checkedAt).toBe(checkedAt)
      h.elapse(2)
      fails = false
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls[1]?.[1]).toContain('centralu@9999.0.1')
    })

    it.each(['9999.0.2', null])('keeps install errors through a forced check answering %s until another install (#636 review)', async (registry) => {
      let fails = true
      const h = make({ registry: '9999.0.1', run: async () => {
        if (fails) throw new Error('EACCES: install denied')
      } })
      await h.svc.check(true)
      h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
      // Every status, including the in-flight one, must keep the failure visible.
      h.offer(registry)
      const original = h.svc.current()
      const before = h.published.length
      await h.svc.check(true)
      expect(h.published.slice(before).every((s) => s.phase === 'failed' && s.error === original.error)).toBe(true)
      expect(h.svc.current()).toMatchObject({ phase: 'failed', error: original.error })
      fails = false
      await expect(h.svc.apply()).resolves.toMatchObject({ phase: 'updating', error: null })
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
    })

    it('serializes an older check, a fresh lookup and duplicate clicks without changing an active target', async () => {
      const old = deferred<LatestResult>()
      const fresh = deferred<LatestResult>()
      const npm = deferred<void>()
      const fetchLatest = vi.fn()
        .mockResolvedValueOnce({ ok: true, version: '9999.0.1' })
        .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      const h = make({ fetchLatest, run: () => npm.promise })
      await h.svc.check(true)
      h.elapse(60_000)
      const checking = h.svc.check(true)
      h.svc.apply()
      h.svc.apply()
      old.resolve({ ok: true, version: '9999.0.2' })
      await checking
      await vi.waitFor(() => expect(fetchLatest).toHaveBeenCalledTimes(3))
      expect(h.svc.current().phase).toBe('updating')
      h.svc.apply()
      expect((await h.svc.check(true)).phase).toBe('updating')
      fresh.resolve({ ok: true, version: '9999.0.3' })
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      h.svc.apply()
      await h.svc.check(true)
      expect(fetchLatest).toHaveBeenCalledTimes(3)
      npm.resolve()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.3']]])
    })

    it.each(['lookup', 'npm', 'retry'] as const)('starts no more commands or status events after shutdown during %s', async (stage) => {
      const gate = deferred<void>()
      let fetching = 0
      let commands = 0
      const h = make({ installedCopy: '/mock/Centralu', fetchLatest: async () => {
        if (++fetching === 2 && stage === 'lookup') await gate.promise
        return { ok: true, version: '9999.0.1' }
      }, run: async () => {
        if (stage === 'npm') await gate.promise
        if (stage === 'retry' && ++commands === 1) throw new Error('ETARGET')
      }, wait: () => gate.promise })
      await h.svc.check(true)
      h.elapse(60_000)
      h.svc.apply()
      await vi.waitFor(() => {
        if (stage === 'lookup') expect(fetching).toBe(2)
        else if (stage === 'retry') expect(h.svc.current().phase).toBe('waiting_for_npm')
        else expect(h.calls).toHaveLength(1)
      })
      h.svc.stop()
      const events = h.published.length
      gate.resolve()
      await settle()
      h.svc.apply()
      await h.svc.check(true)
      expect(h.calls).toHaveLength(stage === 'lookup' ? 0 : 1)
      expect(h.published).toHaveLength(events)
    })

    it('keeps the six-hour background interval and turning checks off does not cancel an install', async () => {
      let now = 100
      const h = make({ registry: '9999.0.1', now: () => now })
      await h.svc.check(false)
      for (const elapsed of [0, 1, 3600_000, 6 * 3600_000 - 1]) {
        now = 100 + elapsed
        await h.svc.check(false)
        expect(h.fetches).toBe(1)
      }
      now++
      await h.svc.check(false)
      expect(h.fetches).toBe(2)
      now += 60_000
      h.offer('9999.0.2')
      h.svc.apply()
      await h.svc.setAuto(false)
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls[0]?.[1]).toContain('centralu@9999.0.2')
    })
  })

  /**
   * What is currently running is answered by a **build constant.**
   *
   * Not the workspace root's package.json — that one is private and is a version nobody installs,
   * so being wrong there causes nothing to happen. `APP_VERSION` guards that it matches the
   * published packages, checked by `tooling/brand.test.ts`.
   */
  it('the current version is the value the build carries', () => {
    expect(make({ current: null }).svc.current().current).toBe(APP_VERSION)
    expect(make().svc.current().current).toBe(RELEASE)
  })

  it('reports it when the registry has something newer (does not install it)', async () => {
    const h = make({ registry: '9999.0.0' })
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    // Nothing happens just from finding out
    expect(s.phase).toBe('idle')
    expect(h.calls).toEqual([])
  })

  it('compares prereleases against each other too — #42 must not resurface here', async () => {
    const h = make({ registry: '0.1.0-beta.99' })
    expect((await h.svc.check(true)).newer).toBe(true)
  })

  /**
   * Failing to reach the registry is **not the same as "up to date."**
   *
   * And it does not erase what was found last time. Erasing it would mean a single network
   * hiccup makes the check undo its own earlier finding, and the screen would look as if nothing
   * had ever happened.
   */
  it('does not throw when the registry cannot be reached, and does not erase the previously known answer', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.offer(null)
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    expect(s.error).toMatch(/registry/i)
  })

  /**
   * When turned off, **nothing is asked anywhere.**
   *
   * The screen calls `check(false)` every time the app opens. Without a guard there, this setting
   * would only block the periodic requests while still letting the once-at-startup call through —
   * a promise only half kept.
   */
  it('an automatic call does not reach the registry when auto-check is turned off', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.setAuto(false)
    const before = h.fetches
    await h.svc.check(false)
    expect(h.fetches).toBe(before)
    // A person clicking it still goes through
    await h.svc.check(true)
    expect(h.fetches).toBe(before + 1)
  })

  /**
   * Installation **names the exact version.**
   *
   * Calling `centralu update` looks like one line, but the judgment of what to install is made by
   * the runner already installed on the user's machine, and that copy's own comparison can be
   * wrong (#42) — answering "already up to date" while doing nothing is exactly the symptom of
   * that defect. Passing the version that was found by name skips that judgment entirely.
   */
  it("names the exact version found and installs it (does not go through the runner's own judgment)", async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    expect((await h.svc.apply()).phase).toBe('updating')
    await settle()
    expect(h.calls[0]).toEqual(['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.0']])
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('records the reason when installation fails (does not silently revert)', async () => {
    const h = make({
      registry: '9999.0.0',
      run: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.svc.current().phase).toBe('failed')
    expect(h.svc.current().error).toMatch(/EACCES/)
  })

  it('refreshes the installed copy after npm, through the launcher that npm just installed', async () => {
    const h = make({ registry: '9999.0.0', installedCopy: 'C:\\Users\\me\\AppData\\Local\\Programs\\Centralu' })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.calls).toEqual([
      ['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.0']],
      ['centralu', ['install']],
    ])
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('when only the copy failed, says npm worked, names the copy and the command that finishes it', async () => {
    const copy = 'C:\\Users\\me\\AppData\\Local\\Programs\\Centralu'
    const h = make({
      registry: '9999.0.0',
      installedCopy: copy,
      run: async (file) => {
        if (file === 'centralu') throw new Error('Windows would not replace it — Centralu is probably still running.')
      },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    const s = h.svc.current()
    expect(s.phase).toBe('failed')
    expect(s.error).toContain('npm installed 9999.0.0')
    expect(s.error).toContain(copy)
    expect(s.error).toContain('still running')
    expect(s.error).toContain('"centralu install"')
  })

  /**
   * An install with nothing newer known refreshes before it refuses (#645). The stored answer may be
   * hours old, or absent with automatic checks off; and "up to date" is a result, never `failed` —
   * recorded as a failure it stayed on the line through every later check.
   */
  describe('install with nothing newer known (#645)', () => {
    it.each([true, false])('refreshes first and answers up to date as a result, not a failure (automatic checks=%s)', async (auto) => {
      const h = make({ registry: RELEASE })
      if (!auto) await h.svc.setAuto(false)
      const before = h.published.length
      const s = await h.svc.apply()
      expect(s).toMatchObject({ phase: 'idle', latest: RELEASE, newer: false, error: null })
      expect(h.fetches).toBe(1)
      expect(h.calls).toEqual([])
      // "Checking…" while it looks, never "Installing…" or "Update failed"
      expect(h.published.slice(before).map((p) => p.phase)).toEqual(['checking', 'idle'])
    })

    it('installs what the refresh finds when the stored answer said up to date', async () => {
      const h = make({ registry: RELEASE })
      await h.svc.check(true)
      h.elapse(3600_000)
      h.offer('9999.0.1')
      expect(await h.svc.apply()).toMatchObject({ phase: 'updating', latest: '9999.0.1', newer: true, error: null })
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.1']]])
    })

    it('an unreachable registry answers like a failed check, and the answer does not stick', async () => {
      const h = make({ registry: null })
      const s = await h.svc.apply()
      expect(s).toMatchObject({ phase: 'idle', latest: null, newer: false, error: 'Could not reach the registry' })
      expect(h.calls).toEqual([])
      h.offer('9999.0.1')
      expect(await h.svc.check(true)).toMatchObject({ phase: 'idle', latest: '9999.0.1', newer: true, error: null })
    })

    it('answers once the target is settled, before npm finishes', async () => {
      const npm = deferred<void>()
      const h = make({ registry: '9999.0.1', run: () => npm.promise })
      await h.svc.check(true)
      h.elapse(60_000)
      h.offer('9999.0.2')
      expect(await h.svc.apply()).toMatchObject({ phase: 'updating', latest: '9999.0.2' })
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.2']]])
      npm.resolve()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
    })
  })

  /**
   * What the installed copy holds decides only one thing: whether `centralu install` runs after npm
   * (#645). npm is the source of truth for releases, so any released version is replaced, a higher one
   * too (a release pulled from `latest` must not survive in /Applications). The one copy kept is a
   * maintainer's local build (`<base>.local.N`) newer than the target, waiting for "Apply now". A
   * version that cannot be read or is malformed is replaced, so a corrupt plist cannot block updates.
   */
  describe('the installed copy after npm (#645)', () => {
    const copy = '/Applications/Centralu.app'
    const target = '9999.0.1-beta.21'

    it.each([`${target}.local.1`, `${target}.local.12`])('a newer local build %s is kept: npm updates the package, the copy is not replaced', async (copyVersion) => {
      const h = make({ registry: target, installedCopy: copy, installedCopyVersion: () => copyVersion })
      await h.svc.check(true)
      await h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', `centralu@${target}`]]])
      expect(h.svc.current().error).toBe(`The local build ${copyVersion} at ${copy} is newer than ${target} and was kept.`)
    })

    it.each([
      // A release pulled from `latest`: a terminal `centralu update` put beta.22 there, then npm went back to beta.21
      '9999.0.1-beta.22',
      '9999.0.1',
      target,
      '9999.0.1-beta.20',
      // An older local build
      '9999.0.1-beta.20.local.9',
      // Unreadable or malformed: never a reason to keep the copy
      'garbage',
      '$(VERSION)',
      '9999.0.1-beta.21.local.0',
      '9999.0.1-beta.21.local.01',
      '9999.0.1.local.1',
      '9999.0.1-beta.21-local.1',
      '',
      null,
    ])('a copy at %s is replaced by the target', async (copyVersion) => {
      const h = make({ registry: target, installedCopy: copy, installedCopyVersion: () => copyVersion })
      await h.svc.check(true)
      await h.svc.apply()
      await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
      expect(h.calls).toEqual([['npm', ['i', '-g', '--prefer-online', `centralu@${target}`]], ['centralu', ['install']]])
      expect(h.svc.current().error).toBeNull()
    })

    it('reads the macOS bundle with the launcher\'s own command, and the version file on Windows', () => {
      const bundle = '/Applications/Centralu.app'
      const launcher = bundleVersionCommand(bundle) as { command: string; args: string[] }
      expect(installedCopyVersionSource(bundle, 'darwin')).toEqual({ kind: 'command', file: launcher.command, args: launcher.args })
      expect(installedCopyVersionSource(bundle, 'win32')).toEqual({ kind: 'file', name: 'centralu-version.txt' })
      expect(installedCopyVersionSource(bundle, 'linux')).toBeNull()
      const dir = mkdtempSync(join(tmpdir(), 'cc-installed-copy-'))
      try {
        expect(readInstalledCopyVersion(dir, 'win32')).toBeNull()
        writeFileSync(join(dir, 'centralu-version.txt'), '0.2.0-beta.21\n')
        expect(readInstalledCopyVersion(dir, 'win32')).toBe('0.2.0-beta.21')
        expect(readInstalledCopyVersion(dir, 'linux')).toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it.runIf(process.platform === 'darwin').each(['xml1', 'binary1'])('reads a %s Info.plist on macOS', (format) => {
      const dir = mkdtempSync(join(tmpdir(), 'cc-installed-copy-'))
      try {
        expect(readInstalledCopyVersion(dir, 'darwin')).toBeNull()
        mkdirSync(join(dir, 'Contents'))
        const plist = join(dir, 'Contents', 'Info.plist')
        writeFileSync(plist, [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0">',
          '<dict>',
          '\t<key>CFBundleName</key>',
          '\t<string>Centralu</string>',
          '\t<key>CFBundleShortVersionString</key>',
          '\t<string>0.2.0-beta.21.local.1</string>',
          '</dict>',
          '</plist>',
          '',
        ].join('\n'))
        execFileSync('/usr/bin/plutil', ['-convert', format, plist])
        expect(readInstalledCopyVersion(dir, 'darwin')).toBe('0.2.0-beta.21.local.1')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('waits for npm to serve a just-published version, then installs that exact version', async () => {
    let tries = 0
    const h = make({
      registry: '9999.0.0',
      run: async (file) => {
        if (file === 'npm' && ++tries === 1) throw new Error('npm error code ETARGET\nnpm error notarget No matching version found')
      },
      wait: async () => {},
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.calls.filter(([file]) => file === 'npm')).toHaveLength(2)
    expect(h.published.some((s) => s.phase === 'waiting_for_npm' && s.error === 'Waiting for npm to serve 9999.0.0')).toBe(true)
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('ends the npm propagation wait at ten minutes instead of retrying forever', async () => {
    let elapsed = 0
    const h = make({
      registry: '9999.0.0',
      run: async () => { throw new Error('npm error code ETARGET') },
      now: () => elapsed,
      wait: async (ms) => { elapsed += ms },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(elapsed).toBe(10 * 60 * 1000)
    expect(h.calls).toHaveLength(21)
    expect(h.svc.current().phase).toBe('failed')
    expect(h.svc.current().error).toContain('ETARGET')
  })

  it('fails non-propagation errors immediately without waiting or retrying', async () => {
    const waits: number[] = []
    const h = make({
      registry: '9999.0.0',
      run: async () => { throw new Error('npm error code EACCES') },
      wait: async (ms) => { waits.push(ms) },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(waits).toEqual([])
    expect(h.svc.current().phase).toBe('failed')
  })

  /**
   * A periodic check after installation finishes must not erase "please restart."
   *
   * The disk has the new version while the running process is still the old one, so a check six
   * hours later would find the exact version just installed as "new" all over again — telling
   * someone to update when they already have.
   */
  it('a check does not overwrite the state while a restart is pending', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect((await h.svc.check(true)).phase).toBe('restart_required')
  })

  /**
   * "Apply updates automatically when idle" (#352): off when the host passes no stored switch (the host's stored default is
   * on since 2026-10-20, update-switches.test.ts), and with it on a newer version
   * found by any check is installed without a click. Applying it stays the window's, once idle.
   */
  describe('automatic apply', () => {
    it('is off by default, and a newer version found is only reported', async () => {
      const h = make({ registry: '9999.0.0' })
      expect(h.svc.current().autoApply).toBe(false)
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
      expect(h.svc.current().phase).toBe('idle')
    })

    it('installs a newer version as soon as a check finds it', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      expect((await h.svc.check(true)).phase).toBe('updating')
      await settle()
      expect(h.calls[0]).toEqual(['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.0']])
      expect(h.svc.current().phase).toBe('restart_required')
    })

    // #1501 review: a stored "on" in the real data folder ran npm i -g under `pnpm host`, whose version is the placeholder
    it.each([
      ['a host from source', { build: 'dev' }],
      ['an unstamped build (a source tree, a remote dev build)', { current: '0.0.0-dev' }],
      ['the build as this source tree carries it', { current: null }],
    ])('never installs by itself on %s, and still shows the release, which a click installs', async (_, o) => {
      const failures: number[] = []
      const h = make({ registry: '9999.0.0', autoApply: true, ...o, schedule: (fn) => { failures.push(1); fn(); return () => {} } })
      expect(await h.svc.check(true)).toMatchObject({ phase: 'idle', newer: true, latest: '9999.0.0', autoApply: true })
      expect(h.svc.setAutoApply(true).phase).toBe('idle')
      await settle()
      expect(h.calls).toEqual([])
      expect(failures).toEqual([])
      expect((await h.svc.apply()).phase).not.toBe('idle')
      await settle()
      expect(h.calls[0]).toEqual(['npm', ['i', '-g', '--prefer-online', 'centralu@9999.0.0']])
    })

    it('does nothing when the registry has nothing newer', async () => {
      const h = make({ registry: '0.0.1', autoApply: true })
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
    })

    it('turning it on installs what is already known, and is saved', async () => {
      const h = make({ registry: '9999.0.0' })
      await h.svc.check(true)
      expect(h.svc.setAutoApply(true).phase).toBe('updating')
      expect(h.saved).toEqual([true])
      await settle()
      expect(h.svc.current()).toMatchObject({ autoApply: true, phase: 'restart_required' })
    })

    it('does not install twice: a check after the install leaves the restart pending', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      await h.svc.check(true)
      await settle()
      await h.svc.check(true)
      await settle()
      expect(h.calls.filter(([f]) => f === 'npm')).toHaveLength(1)
      expect(h.svc.current().phase).toBe('restart_required')
    })

    it('turning it off saves that and installs nothing', async () => {
      const h = make({ registry: '9999.0.0', autoApply: true })
      h.svc.setAutoApply(false)
      expect(h.saved).toEqual([false])
      await h.svc.check(true)
      await settle()
      expect(h.calls).toEqual([])
    })

    /**
     * One failed install must not switch automatic installs off for the host's life (#645). Since
     * checks stopped erasing a failure (#636), "retry at the next check" retried nothing; now a
     * failure is tried again on a backoff, and the error stays on the line until the next attempt.
     */
    describe('after a failed install (#645)', () => {
      function timers() {
        const pending: { fn: () => void; ms: number }[] = []
        return {
          pending,
          schedule: (fn: () => void, ms: number) => {
            const t = { fn, ms }
            pending.push(t)
            return () => {
              const i = pending.indexOf(t)
              if (i >= 0) pending.splice(i, 1)
            }
          },
        }
      }

      it('retries on a backoff — 10 min, 1 h, then every 6 h — and keeps the error until the next attempt starts', async () => {
        let fails = true
        const t = timers()
        const h = make({ registry: '9999.0.1', autoApply: true, schedule: t.schedule, run: async () => {
          if (fails) throw new Error('EACCES: install denied')
        } })
        await h.svc.check(true)
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        expect(h.calls).toHaveLength(1)
        expect(t.pending.map((p) => p.ms)).toEqual([600_000])
        // A check that lands before the delay does not start another npm, and the failure stays visible
        h.elapse(300_000)
        await h.svc.check(true)
        await settle()
        expect(h.calls).toHaveLength(1)
        expect(h.svc.current()).toMatchObject({ phase: 'failed', error: 'EACCES: install denied' })
        for (const next of [3600_000, 6 * 3600_000, 6 * 3600_000]) {
          const due = t.pending.shift()!
          h.elapse(due.ms)
          due.fn()
          await vi.waitFor(() => expect(t.pending).toHaveLength(1))
          expect(h.svc.current()).toMatchObject({ phase: 'failed', error: 'EACCES: install denied' })
          expect(t.pending[0]?.ms).toBe(next)
        }
        expect(h.calls).toHaveLength(4)
        // Each attempt is announced as an install, with the earlier failure cleared for its duration
        expect(h.published.filter((p) => p.phase === 'updating').every((p) => p.error === null)).toBe(true)
        fails = false
        const due = t.pending.shift()!
        h.elapse(due.ms)
        due.fn()
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
        expect(h.calls).toHaveLength(5)
        expect(h.svc.current().error).toBeNull()
        expect(t.pending).toEqual([])
      })

      it('a check after the delay retries too, and a release that is not the one that failed is tried at once', async () => {
        let fails = true
        const h = make({ registry: '9999.0.1', autoApply: true, run: async () => {
          if (fails) throw new Error('ENOTFOUND registry.npmjs.org')
        } })
        await h.svc.check(true)
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        h.elapse(600_000)
        await h.svc.check(true)
        await vi.waitFor(() => expect(h.calls).toHaveLength(2))
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        // The second failure of 9999.0.1 waits an hour; 9999.0.2 has not failed yet
        h.offer('9999.0.2')
        await h.svc.check(true)
        await vi.waitFor(() => expect(h.calls).toHaveLength(3))
        expect(h.calls[2]?.[1]).toContain('centralu@9999.0.2')
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        fails = false
        await h.svc.check(true)
        await settle()
        expect(h.calls).toHaveLength(3)
      })

      it('turning automatic apply off cancels the retry, on schedules it, and shutdown cancels it', async () => {
        const t = timers()
        const h = make({ registry: '9999.0.1', schedule: t.schedule, run: async () => {
          throw new Error('EACCES')
        } })
        await h.svc.check(true)
        await h.svc.apply()
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        // A failure without the setting is left for the person (#636)
        expect(t.pending).toEqual([])
        h.elapse(100_000)
        h.svc.setAutoApply(true)
        expect(t.pending.map((p) => p.ms)).toEqual([500_000])
        h.svc.setAutoApply(false)
        expect(t.pending).toEqual([])
        h.svc.setAutoApply(true)
        expect(t.pending.map((p) => p.ms)).toEqual([500_000])
        h.svc.stop()
        expect(t.pending).toEqual([])
        t.schedule(() => {}, 0)
        h.svc.setAutoApply(false)
        h.svc.setAutoApply(true)
        expect(h.calls).toHaveLength(1)
      })

      it('a retry that fires during a manual install does not start a second one', async () => {
        let fails = true
        const npm = deferred<void>()
        const t = timers()
        const h = make({ registry: '9999.0.1', autoApply: true, schedule: t.schedule, run: async () => {
          if (fails) throw new Error('EACCES')
          await npm.promise
        } })
        await h.svc.check(true)
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('failed'))
        fails = false
        const due = t.pending[0]!
        await h.svc.apply()
        // The click is the attempt: the pending retry went with it
        expect(t.pending).toEqual([])
        due.fn()
        await settle()
        expect(h.calls).toHaveLength(2)
        npm.resolve()
        await vi.waitFor(() => expect(h.svc.current().phase).toBe('restart_required'))
        expect(h.calls).toHaveLength(2)
      })
    })
  })
})

/** Node's own `npm.cmd`, as Node 24.21's Windows installer writes it (read 2026-10-08) */
const NODE_NPM_CMD = [
  ":: Created by npm, please don't edit manually.",
  '@ECHO OFF',
  '',
  'SETLOCAL',
  '',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  `FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (`,
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  '',
].join('\r\n')

/** npm's cmd-shim for the launcher, as `npm i -g centralu` wrote it (Windows 11, 2026-10-08) */
const CENTRALU_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\centralu\\bin\\centralu.mjs" %*',
  '',
].join('\r\n')

/**
 * Windows (#14), where the in-app update failed with "spawn npm ENOENT" up to 0.1.0-beta.12:
 * `npm` and `centralu` are batch files there, which `execFile` without a shell cannot start, and
 * the copy `centralu install` makes was never looked for, so it was never refreshed.
 */
// #1501 re-check: a dev hub, or one at the placeholder, never updates its linked machines by itself
describe('the hub updating its linked machines (hubUpdatesMachines)', () => {
  it('follows only from a build that may install by itself, with automatic updates on and no swap under way', () => {
    const on = { build: 'abc1234', current: '0.2.0-beta.4', autoApply: true, draining: false }
    expect(hubUpdatesMachines(on)).toBe(true)
    expect(hubUpdatesMachines({ ...on, build: 'dev' })).toBe(false)
    expect(hubUpdatesMachines({ ...on, current: '0.0.0-dev' })).toBe(false)
    expect(hubUpdatesMachines({ ...on, autoApply: false })).toBe(false)
    expect(hubUpdatesMachines({ ...on, draining: true })).toBe(false)
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).toContain('autoUpdate: () => hubUpdatesMachines({ build: BUILD, current: APP_VERSION,')
  })
})

describe('updating on Windows', () => {
  const nodeDir = 'C:\\Program Files\\nodejs'
  const npmDir = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm'
  const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`
  const launcher = `${npmDir}\\node_modules\\centralu\\bin\\centralu.mjs`
  const NODE = `${nodeDir}\\node.exe`
  const files: Record<string, string> = {
    [`${nodeDir}\\npm.cmd`]: NODE_NPM_CMD,
    [npmCli]: '',
    [`${npmDir}\\centralu.cmd`]: CENTRALU_SHIM,
    [launcher]: '',
  }
  const env = { Path: `C:\\WINDOWS\\system32;${nodeDir}\\;${npmDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const resolve = (file: string) =>
    resolveCommand(file, env, {
      platform: 'win32',
      read: (p) => files[p] ?? '',
      exists: (p) => p in files,
      node: NODE,
      runJs: () => null,
    })

  it('npm runs as Node and npm-cli.js, never as a bare name or a .cmd', () => {
    expect(commandFor('npm', ['i', '-g', 'centralu@0.1.0-beta.13'], resolve)).toEqual({
      file: NODE,
      args: [npmCli, 'i', '-g', 'centralu@0.1.0-beta.13'],
    })
  })

  it('centralu install runs the launcher npm just installed, through Node', () => {
    expect(commandFor('centralu', ['install'], resolve)).toEqual({ file: NODE, args: [launcher, 'install'] })
  })

  it('the installed copy is the one in %LOCALAPPDATA%\\Programs', () => {
    const home = 'C:\\Users\\Jane Doe'
    const expected = win32.join(home, 'AppData', 'Local', 'Programs', 'Centralu')
    expect(installedCopyPath('win32', { LOCALAPPDATA: `${home}\\AppData\\Local` }, home)).toBe(expected)
    // The launcher's own fallback when LOCALAPPDATA is not set
    expect(installedCopyPath('win32', {}, home)).toBe(expected)
  })

  it("is the path the launcher's install writes and its update refreshes, on every platform", () => {
    const cases: [NodeJS.Platform, Record<string, string>, string][] = [
      ['win32', { LOCALAPPDATA: 'D:\\Profiles\\jane\\Local' }, 'C:\\Users\\jane'],
      ['darwin', {}, '/Users/jane'],
      ['linux', {}, '/home/jane'],
    ]
    for (const [platform, e, home] of cases) {
      expect(installedCopyPath(platform, e, home)).toBe((installedPaths(platform, e, home) as string[])[0])
    }
  })
})

describe('what a failed command says', () => {
  it('npm: its last line, not the pointer to its log', () => {
    const stderr = [
      'npm error code EACCES',
      "npm error EACCES: permission denied, mkdir '/usr/lib/node_modules/centralu'",
      'npm error A complete log of this run can be found in: C:\\Users\\me\\AppData\\Local\\npm-cache\\_logs\\x.log',
      '',
    ].join('\r\n')
    expect(failureDetail('npm', stderr)).toBe("npm error EACCES: permission denied, mkdir '/usr/lib/node_modules/centralu'")
  })

  it('the launcher: its first line, which says why, not the advice meant for a terminal', () => {
    const stderr =
      'Windows would not replace C:\\x — Centralu is probably still running.\nQuit it (close the window and choose Quit), then run the command again.\n'
    expect(failureDetail('centralu', stderr)).toBe('Windows would not replace C:\\x — Centralu is probably still running.')
  })
})

/**
 * The real thing, on the Windows CI job: Node's own `npm.cmd` and npm's `centralu.cmd` on disk,
 * started by `runCommand` with nothing but PATH to go on. Before the fix this failed as the app
 * did, "spawn npm ENOENT".
 */
describe.runIf(process.platform === 'win32')('runCommand with real batch files (Windows)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'centralu-update-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const nodeDir = join(dir, 'nodejs')
  const prefix = join(dir, 'prefix')
  const argsFile = (name: string) => join(dir, `${name}.args.json`)
  const recorder = (name: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile(name))}, JSON.stringify(process.argv.slice(2)))\n`
  mkdirSync(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'node_modules', 'centralu', 'bin'), { recursive: true })
  writeFileSync(join(nodeDir, 'npm.cmd'), NODE_NPM_CMD)
  writeFileSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), recorder('npm'))
  writeFileSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), `console.log(${JSON.stringify(prefix)})\n`)
  writeFileSync(join(prefix, 'centralu.cmd'), CENTRALU_SHIM)
  // The launcher is an ES module; createRequire keeps the recorder one line
  writeFileSync(
    join(prefix, 'node_modules', 'centralu', 'bin', 'centralu.mjs'),
    `import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n${recorder('centralu')}`,
  )
  const systemDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const env = { ...process.env, PATH: [systemDir, nodeDir, prefix].join(';') }
  const resolve = (file: string) => resolveCommand(file, env)

  it('npm i -g reaches npm-cli.js with its arguments as given', async () => {
    await runCommand('npm', ['i', '-g', 'centralu@0.1.0-beta.13'], resolve)
    expect(JSON.parse(readFileSync(argsFile('npm'), 'utf8'))).toEqual(['i', '-g', 'centralu@0.1.0-beta.13'])
  })

  it('centralu install reaches the launcher', async () => {
    await runCommand('centralu', ['install'], resolve)
    expect(JSON.parse(readFileSync(argsFile('centralu'), 'utf8'))).toEqual(['install'])
  })
})
