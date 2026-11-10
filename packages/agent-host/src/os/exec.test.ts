import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, cleanUp, plantTreeScript, settle, treePids } from '../dev-services/process-tree.test-helpers.js'
import { endChild } from '../links/ssh-run.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { execText, type ExecFailure } from './exec.js'
import { memoryOs } from './memory.js'
import { realOs } from './real.js'

describe('execText', () => {
  it('answers the output of a program that exits 0', async () => {
    const r = await execText(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err')"], { timeoutMs: 30_000 })
    expect(r).toEqual({ stdout: 'out', stderr: 'err' })
  })

  it('rejects with the output of a program that exits 1, which callers still read (claude auth status)', async () => {
    const e = await execText(process.execPath, ['-e', "process.stdout.write('{\"loggedIn\":false}'); process.exit(1)"], { timeoutMs: 30_000 }).catch((x: ExecFailure) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ stdout: '{"loggedIn":false}', code: 1 })
  })

  it('rejects with the start error of a program that is not there', async () => {
    await expect(execText(join(tmpdir(), 'cc-no-such-program-for-exec-text'), [], { timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a run the limit ended, and says so', async () => {
    const e = await execText(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 * SLOW }).catch((x: ExecFailure) => x)
    expect(e).toMatchObject({ ended: 'timeout' })
  }, 60_000 * SLOW)

  // A probe is in the host's group, not a group of its own: what ends the host's group ends it (`StartOptions.contained`)
  it('runs the program in the host group, and a stop reaches what it started there', async () => {
    const os = memoryOs({ as: 'posix' })
    os.programs.add('/usr/bin/tool', (ctx) => {
      ctx.start('/usr/bin/helper', [])
      return new Promise(() => {})
    })
    os.programs.add('/usr/bin/helper', (ctx) => new Promise(() => void ctx.ended))
    const ran = execText('/usr/bin/tool', [], { timeoutMs: 1000 }, os).catch((e: ExecFailure) => e)
    await os.clock.advance(0)
    const rows = () => os.processTable().filter((p) => p.command.startsWith('/usr/bin/'))
    expect(rows().map((p) => p.pgid)).toEqual([os.processes.pid, os.processes.pid])
    await os.clock.advance(1000)
    expect(await ran).toMatchObject({ ended: 'timeout' })
    await os.clock.advance(2000)
    expect(rows().every((p) => !p.alive)).toBe(true)
  })

  it('goes through the OS it is given', async () => {
    const seen: string[] = []
    const os = { processes: { run: async (command: string) => (seen.push(command), { code: 0, signal: null, stdout: Buffer.from('v1\n'), stderr: Buffer.alloc(0) }) } }
    expect(await execText('tool', ['--version'], { timeoutMs: 1 }, os as unknown as ReturnType<typeof realOs>)).toEqual({ stdout: 'v1\n', stderr: '' })
    expect(seen).toEqual(['tool'])
  })
})

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
