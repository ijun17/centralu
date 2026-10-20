import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as kit from '../apps/external/test-helpers.js'
import { attachWorld } from './session-apps.test-helpers.js'

/**
 * `attachWorld().dispose()` removes the world's folder while something an app started can still be ending (#368).
 * On Windows a folder a process works in cannot be removed (EBUSY) until the process has let go, and a descendant of
 * an app outlives the runtime's dispose by a few milliseconds: `tool-prefix.test.ts` met it on windows-2022
 * (`EBUSY: resource busy or locked, rmdir '…\cc-apps-attach-…\p1\.centralu\apps\pinned-app'`, 2026-10-11).
 */
describe('attachWorld dispose', () => {
  let holder: ChildProcess | undefined
  afterEach(() => {
    holder?.kill()
    holder = undefined
  })

  // Windows only: elsewhere a folder a process works in can be removed, so the old plain rmSync passed too
  it.runIf(process.platform === 'win32')("removes the world's folder even when a process of the app is still working in it for a moment", async () => {
    const w = attachWorld(kit)
    const appFolder = w.plant('p1', 'notes')
    // A stand-in for the app's descendant: it works in the app's folder and ends on its own a second later
    holder = spawn(process.execPath, ['-e', "console.log('ready'); setTimeout(() => {}, 1000)"], { cwd: appFolder, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    await new Promise<void>((resolve, reject) => {
      holder!.once('error', reject)
      holder!.stdout!.once('data', () => resolve())
    })

    await w.dispose()

    expect(existsSync(w.root)).toBe(false)
    expect(existsSync(w.roots.p1)).toBe(false)
  })
})
