import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KILL_GRACE_MS } from '../dev-services/kill-tree.js'
import { goneWithin, helperPid, killLeftovers } from './fake-agent-cli.test-helpers.js'
import { HOST_WATCH, spawnLocalAgent } from './local-process.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * A CLI this host starts must not outlive it (#1562 review, measured on macOS): Cursor with Centralu's bridge attached
 * stayed up 60 s and more after its host was SIGKILLed, and a shell Cursor started in a group of its own outlived Cursor.
 * Real processes; macOS and Linux only (Windows ends a host's children with it: its kill-on-close job, and the sweep by
 * parent links after a CLI dies).
 */

const unix = process.platform !== 'win32'
vi.setConfig({ testTimeout: 30_000 * SLOW })
const started: number[] = []
let dir: string | null = null
afterEach(() => {
  killLeftovers(started)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

/** A CLI that takes no notice of stdin's end (Cursor with a session open, measured): it runs until something kills it */
const deafCli = { command: process.execPath, args: ['-e', "process.stdout.write(process.pid + '\\n'); process.stdin.resume(); setInterval(() => {}, 1000)"] }

describe('a CLI that must end with its host', () => {
  it('starts behind the host watch, which ends the group once the host’s end of its pipe closes', () => {
    expect(HOST_WATCH).toContain('exec "$@" 3<&-')
    expect(HOST_WATCH).toContain('kill -9 0')
  })

  it.skipIf(!unix)('ends when its host is SIGKILLed, though it ignores stdin’s end', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    const host = join(dir, 'host.mts')
    // A host of its own, which starts the CLI as an adapter does and is then killed outright
    writeFileSync(
      host,
      [
        `import { spawnLocalAgent } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'local-process.ts')).href)}`,
        `const p = spawnLocalAgent({ command: ${JSON.stringify(deafCli.command)}, args: ${JSON.stringify(deafCli.args)}, env: process.env, endsWithHost: true })`,
        "p.stdout.on('data', (d) => process.stdout.write(d))",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const h = spawn(process.execPath, ['--import', 'tsx', host], { stdio: ['ignore', 'pipe', 'inherit'] })
    const cli = await helperPid(h.stdout)
    started.push(cli, h.pid!)
    h.kill('SIGKILL')
    expect(await goneWithin(cli, 10_000)).toBe(true)
  })

  it.skipIf(!unix)('ends, with it, a helper it started in a group of its own, once its tree was noted', async () => {
    // The helper leads a group of its own, as Cursor's shell does: the CLI's own group's sweep does not reach it
    const script = [
      "const { spawn } = require('node:child_process')",
      "const helper = spawn(process.execPath, ['-e', \"console.log('up'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })",
      "helper.stdout.once('data', () => { process.stdout.write(helper.pid + '\\n'); helper.stdout.destroy() })",
      'process.stdin.resume()',
      'setInterval(() => {}, 1000)',
    ].join('\n')
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', script], env: process.env, endsWithHost: true })
    const helper = await helperPid(p.stdout)
    started.push(helper, p.pid!)
    p.noteTree()
    const exited = new Promise((r) => p.once('exit', r))
    // Killed from outside, as a crash: not this host's stop, which ends the tree while it is still a tree
    process.kill(p.pid!, 'SIGKILL')
    await exited
    expect(await goneWithin(helper, KILL_GRACE_MS + 5000)).toBe(true)
  })

  it('starts as before without it, and where there are no process groups', async () => {
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', "process.stdout.write(process.pid + '\\n')"], env: process.env })
    const pid = await helperPid(p.stdout)
    started.push(pid)
    expect(pid).toBe(p.pid)
  })
})
