import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, cleanUp, plantTreeScript, settle, treePids } from '../dev-services/process-tree.test-helpers.js'
import { realOs } from '../os/real.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { endChild } from './ssh-run.js'

/**
 * An ssh is ended with the shared stop: what it started (a `ProxyCommand`, `ProxyJump`'s second ssh) goes with it. The
 * stop it had before signalled the pid, and a ProxyCommand that ignored the TERM its ssh passed on ran on.
 */
describe('endChild', () => {
  let dir = ''
  let pids: number[] = []
  afterEach(async (test) => {
    await cleanUp(pids, test)
    pids = []
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('ends the program and everything it started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ssh-end-'))
    const pidFile = join(dir, 'pids')
    const child = realOs().processes.start(process.execPath, [plantTreeScript(dir), pidFile, '2'], { stdio: ['ignore', 'ignore', 'ignore'] })
    pids = await settle(() => treePids(pidFile), (p) => p.length === 3, 20_000 * SLOW)
    expect(pids).toHaveLength(3)
    await endChild(child, 200)
    expect(await settle(() => pids.filter(alive), (left) => left.length === 0, 15_000 * SLOW)).toEqual([])
  }, 60_000 * SLOW)

  it('is done at once for a program that has already exited', async () => {
    const child = realOs().processes.start(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] })
    await child.exited
    await endChild(child)
  })
})
