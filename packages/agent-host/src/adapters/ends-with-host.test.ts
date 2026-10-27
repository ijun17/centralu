import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** A CLI that starts a helper leading a group of its own, as Cursor's shell does (the CLI's own group's sweep does not reach
 * it), and writes the helper's pid */
const helperCli = [
  "const { spawn } = require('node:child_process')",
  "const helper = spawn(process.execPath, ['-e', \"console.log('up'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })",
  "helper.stdout.once('data', () => { process.stdout.write(helper.pid + '\\n'); helper.stdout.destroy() })",
  'process.stdin.resume()',
  'setInterval(() => {}, 1000)',
].join('\n')

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
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', helperCli], env: process.env, endsWithHost: true })
    const helper = await helperPid(p.stdout)
    started.push(helper, p.pid!)
    await p.noteTree()
    const exited = new Promise((r) => p.once('exit', r))
    // Killed from outside, as a crash: not this host's stop, which ends the tree while it is still a tree
    process.kill(p.pid!, 'SIGKILL')
    await exited
    expect(await goneWithin(helper, KILL_GRACE_MS + 5000)).toBe(true)
  })

  it.skipIf(!unix)('ends, when its host is SIGKILLed, a helper it started in a group of its own, once its tree was noted', async () => {
    // #1562 Mac re-check: Cursor's `zsh -c …` and the `sleep 300` it ran, in a group of their own, outlived a killed host
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    const host = join(dir, 'host.mts')
    writeFileSync(
      host,
      [
        `import { spawnLocalAgent } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'local-process.ts')).href)}`,
        `const p = spawnLocalAgent({ command: process.execPath, args: ['-e', ${JSON.stringify(helperCli)}], env: process.env, endsWithHost: true })`,
        "p.stdout.once('data', async (d) => { await p.noteTree(); process.stdout.write(d) })",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const h = spawn(process.execPath, ['--import', 'tsx', host], { stdio: ['ignore', 'pipe', 'inherit'] })
    const helper = await helperPid(h.stdout)
    started.push(helper, h.pid!)
    h.kill('SIGKILL')
    expect(await goneWithin(helper, 10_000)).toBe(true)
  })

  it.skipIf(!unix)('ends such a helper when its host is SIGKILLed the moment it starts, before any of its tree was noted', async () => {
    // #1562 Mac re-check: a host killed within 2 s of a command's start (before `noteTree`'s clock) left the shell alive
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    const host = join(dir, 'host.mts')
    writeFileSync(
      host,
      [
        `import { spawnLocalAgent } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'local-process.ts')).href)}`,
        `const p = spawnLocalAgent({ command: process.execPath, args: ['-e', ${JSON.stringify(helperCli)}], env: process.env, endsWithHost: true })`,
        "p.stdout.on('data', (d) => process.stdout.write(d))",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const h = spawn(process.execPath, ['--import', 'tsx', host], { stdio: ['ignore', 'pipe', 'inherit'] })
    const helper = await helperPid(h.stdout)
    started.push(helper, h.pid!)
    h.kill('SIGKILL')
    expect(await goneWithin(helper, 10_000)).toBe(true)
  })

  /*
   * Every tool started by this host, through the process seam (#1654 Q3): Codex's app-server and Claude Code end with a host
   * killed outright, as ACP's tools already did, whatever they do with stdin's end. The CLI writes its pid to a file: the
   * tool's own reader takes its stdout.
   */
  const pidFileCli = (file: string) => ({
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000)`],
  })
  async function pidIn(file: string): Promise<number> {
    for (let i = 0; i < 200; i++) {
      if (existsSync(file) && readFileSync(file, 'utf8')) return Number(readFileSync(file, 'utf8'))
      await new Promise((r) => setTimeout(r, 50 * SLOW))
    }
    throw new Error('the CLI wrote no pid')
  }
  async function endsWithItsHost(lines: (cli: { command: string; args: string[] }) => string[]): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    const host = join(dir, 'host.mts')
    const file = join(dir, 'cli.pid')
    writeFileSync(host, [...lines(pidFileCli(file)), 'setInterval(() => {}, 1000)'].join('\n'))
    const h = spawn(process.execPath, ['--import', 'tsx', host], { stdio: ['ignore', 'ignore', 'inherit'] })
    started.push(h.pid!)
    const cli = await pidIn(file)
    started.push(cli)
    h.kill('SIGKILL')
    expect(await goneWithin(cli, 10_000)).toBe(true)
  }
  const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, file)).href)

  it.skipIf(!unix)('ends Codex’s app-server when its host is SIGKILLed', async () => {
    await endsWithItsHost((cli) => [
      `import { CodexClient } from ${moduleUrl('codex/client.ts')}`,
      `new CodexClient({ onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} }, { command: ${JSON.stringify(cli.command)}, args: ${JSON.stringify(cli.args)} })`,
    ])
  })

  it.skipIf(!unix)('ends Claude Code when its host is SIGKILLed', async () => {
    await endsWithItsHost((cli) => [
      `import { claudeQueryOptions } from ${moduleUrl('claude/sdk-query.ts')}`,
      `import { spawnLocalAgent } from ${moduleUrl('local-process.ts')}`,
      "const o = claudeQueryOptions({ sessionId: 's1', opts: { sessionId: 's1', cwd: process.cwd(), permissionPreset: 'normal' }, executablePath: undefined, servers: {}, permissionOptions: { permissionMode: 'default' }, codeIntelligence: {}, spawn: spawnLocalAgent, canUseTool: async () => ({ behavior: 'deny', message: '' }) })",
      `o.spawnClaudeCodeProcess({ command: ${JSON.stringify(cli.command)}, args: ${JSON.stringify(cli.args)}, env: process.env })`,
    ])
  })

  it.skipIf(!unix)('says a CLI that is not there did not start, as without the watch, not that it crashed', async () => {
    // Behind the watch `sh` always starts, and its `exec` of a missing program exits 127: Codex said "exited (code 127)"
    for (const command of ['/nonexistent/cc-no-such-cli', 'cc-no-such-cli']) {
      const p = spawnLocalAgent({ command, args: [], env: process.env, endsWithHost: true })
      const error = await new Promise<Error>((resolve) => p.once('error', resolve))
      expect(error).toMatchObject({ code: 'ENOENT' })
      expect(p.pid).toBeUndefined()
    }
  })

  it('starts as before without it, and where there are no process groups', async () => {
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', "process.stdout.write(process.pid + '\\n')"], env: process.env })
    const pid = await helperPid(p.stdout)
    started.push(pid)
    expect(pid).toBe(p.pid)
  })
})
