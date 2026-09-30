import { describe, expect, it } from 'vitest'
import { APP_VERSION, type UpdateStatus } from '@cc/protocol'
import { UpdateService, type LatestResult } from './updates.js'

/**
 * Checking for and installing app updates (issue #43).
 *
 * **None of these tests reach out to the registry or run `npm i -g`.** Both pass only through
 * injected seams, and that is the guarantee that this file cannot alter this machine.
 */
function make(opts: { registry?: string | null; run?: (file: string, args: string[]) => Promise<void> } = {}) {
  const published: UpdateStatus[] = []
  const calls: [string, string[]][] = []
  let registry = opts.registry ?? null
  let fetches = 0
  const svc = new UpdateService((s) => published.push(s), {
    fetchLatest: async (): Promise<LatestResult> => {
      fetches++
      return registry === null ? { ok: false, reason: 'Could not reach the registry' } : { ok: true, version: registry }
    },
    run: async (file, args) => {
      calls.push([file, args])
      await (opts.run?.(file, args) ?? Promise.resolve())
    },
  })
  return {
    svc,
    published,
    calls,
    get fetches() {
      return fetches
    },
    offer: (v: string | null) => {
      registry = v
    },
  }
}

/** Waits until state settles into shape — installation finishes after this returns */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('UpdateService', () => {
  /**
   * What is currently running is answered by a **build constant.**
   *
   * Not the workspace root's package.json — that one is private and is a version nobody installs,
   * so being wrong there causes nothing to happen. `APP_VERSION` guards that it matches the
   * published packages, checked by `tooling/brand.test.ts`.
   */
  it('the current version is the value the build carries', () => {
    expect(make().svc.current().current).toBe(APP_VERSION)
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
    expect(h.svc.apply().phase).toBe('updating')
    await settle()
    expect(h.calls[0]).toEqual(['npm', ['i', '-g', 'centralu@9999.0.0']])
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

  it('says so when called with nothing to update (instead of doing nothing silently)', async () => {
    const h = make({ registry: null })
    const s = h.svc.apply()
    expect(s.phase).toBe('failed')
    expect(h.calls).toEqual([])
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
})
