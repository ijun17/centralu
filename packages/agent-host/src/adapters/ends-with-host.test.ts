import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KILL_GRACE_MS } from '../dev-services/kill-tree.js'
import { goneWithin, helperPid, killLeftovers } from './fake-agent-cli.test-helpers.js'
import { FIND_CLI, HOST_WATCH, spawnLocalAgent } from './local-process.js'
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
    expect(HOST_WATCH).toContain('exec "$@" 3<&- 4>&-')
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

  /*
   * Behind the watch `sh` always starts, so a program that is not there or cannot be run used to read as an exit code (127,
   * 126): Codex said "exited (code 127)". The shell that will `exec` looks it up itself and says so before it does, and the
   * host raises what Node's spawn raises without the watch. The PATH is the test's own, never the runner's: npx and pnpm put
   * a relative `./node_modules/.bin` on it, a login shell may leave `~/...` or an empty entry.
   */
  const startError = (env: Record<string, string | undefined>, command: string, cwd?: string) => {
    const p = spawnLocalAgent({ command, args: [], env, cwd, endsWithHost: true })
    return new Promise<{ error: Error; exits: number[] }>((resolve) => {
      const exits: number[] = []
      p.once('exit', (code: number) => exits.push(code))
      p.once('error', (error) => setTimeout(() => resolve({ error, exits }), 100))
    })
  }

  it.skipIf(!unix)('says a CLI that is not there did not start, as without the watch, not that it crashed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    mkdirSync(join(dir, 'rel'))
    const bin = '/usr/bin:/bin'
    const paths: (string | undefined)[] = [bin, `${bin}:./rel`, `${bin}:~/cc-no-such-dir`, `${bin}::`, `:${bin}`, undefined]
    for (const PATH of paths) {
      for (const command of ['/nonexistent/cc-no-such-cli', 'cc-no-such-cli', './cc-no-such-cli']) {
        const { error } = await startError({ PATH }, command, dir)
        expect(error, `PATH=${PATH} ${command}`).toMatchObject({ code: 'ENOENT', syscall: `spawn ${command}` })
      }
    }
  })

  it.skipIf(!unix)('finds a CLI on a relative or empty PATH entry, from the folder it starts in', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    mkdirSync(join(dir, 'rel'))
    const cli = join(dir, 'rel', 'cc-rel-cli')
    writeFileSync(cli, '#!/bin/sh\necho started\n', { mode: 0o755 })
    for (const PATH of ['/usr/bin:/bin:rel', '/usr/bin:/bin:./rel']) {
      const p = spawnLocalAgent({ command: 'cc-rel-cli', args: [], env: { PATH }, cwd: dir, endsWithHost: true })
      const failed = vi.fn()
      p.on('error', failed)
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      await new Promise((r) => p.once('exit', r))
      expect(out, PATH).toBe('started\n')
      expect(failed).not.toHaveBeenCalled()
    }
  })

  it.skipIf(!unix || process.getuid?.() === 0)('says a file that cannot be run, or a folder, did not start (EACCES), as without the watch', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
    writeFileSync(join(dir, 'plain'), 'not a program', { mode: 0o644 })
    mkdirSync(join(dir, 'folder'))
    const cases: [string, Record<string, string>][] = [
      [join(dir, 'plain'), { PATH: '/usr/bin:/bin' }],
      [join(dir, 'folder'), { PATH: '/usr/bin:/bin' }],
    ]
    for (const [command, env] of cases) {
      const { error } = await startError(env, command)
      const node = await new Promise<Error>((resolve) => spawn(command, [], { env }).once('error', resolve))
      expect(error, command).toMatchObject({ code: 'EACCES' })
      expect(node).toMatchObject({ code: 'EACCES' })
    }
  })

  /*
   * The lookup is one script run by whatever `sh` the OS has, and shells differ on a file that cannot be run: dash's
   * `command -v` prints its path, macOS's `sh` fails (the macOS re-check of #1668: an absolute path to a plain file read
   * ENOENT where Node says EACCES), and Ubuntu 22.04's dash 0.5.11 prints the first file of a name, runnable or not, and
   * without its folder when an empty PATH entry found it (the 0.1.0-beta.43 rehearsal: no EACCES behind an empty entry, and
   * EACCES for a file Node runs from a later entry). So the decision is run under the OS's sh, under a POSIX bash, under a
   * bash whose `command -v` fails for every name with a slash, which is how macOS's answers, and under one whose
   * `command -v` answers as dash 0.5.11's does.
   */
  describe.skipIf(!unix)('the lookup before the watch, in each kind of sh', () => {
    const macLike = 'command() { case "$*" in */*) return 1;; esac; builtin command "$@"; }; '
    const dash011 =
      'command() { [ "$1" = -v ] || { builtin command "$@"; return; }; shift; [ "$1" = -- ] && shift; ' +
      '(IFS=:; set -f; for d in ${PATH:+$PATH:}/dev/null; do if [ -f "${d:-.}/$1" ]; then echo "${d:+$d/}$1"; exit 0; fi; done; exit 1); }; '
    const shells: [string, string, string[]][] = [
      ['sh', '', []],
      ['bash --posix', '', ['--posix']],
      ['a sh whose command -v fails for a path', macLike, []],
      ['a sh whose command -v prints the first file, runnable or not (dash 0.5.11)', dash011, []],
    ]
    const available = (name: string) => spawnSync(name, ['-c', 'exit 0']).status === 0
    // By its path: an empty PATH would not find the shell itself
    const where = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`]).stdout.toString().trim()
    const say = (shell: string, flags: string[], prelude: string, command: string, cwd: string, PATH: string | undefined) => {
      const r = spawnSync(where(shell), [...flags, '-c', `${prelude}${FIND_CLI}exit 0`, 'x', command], { cwd, env: PATH === undefined ? {} : { PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'pipe'] })
      return { said: String(r.output[4] ?? '').trim(), status: r.status }
    }
    for (const [label, prelude, flags] of shells) {
      const shell = label.startsWith('bash') || prelude ? 'bash' : 'sh'
      it.skipIf(!available(shell))(`says ENOENT, EACCES or nothing as Node does: ${label}`, () => {
        dir = mkdtempSync(join(tmpdir(), 'cc-ends-with-host-'))
        const bin = join(dir, 'bin')
        mkdirSync(bin)
        mkdirSync(join(dir, 'bin', 'folder-cli'))
        writeFileSync(join(bin, 'plain-cli'), 'not a program', { mode: 0o644 })
        writeFileSync(join(bin, 'good-cli'), '#!/bin/sh\n', { mode: 0o755 })
        chmodSync(join(bin, 'plain-cli'), 0o644)
        mkdirSync(join(dir, 'early'))
        writeFileSync(join(dir, 'early', 'good-cli'), 'not a program', { mode: 0o644 })
        chmodSync(join(dir, 'early', 'good-cli'), 0o644)
        const sys = '/usr/bin:/bin'
        const cases: [string, string, string | undefined, string, number | null][] = [
          ['absolute, missing', join(dir, 'nothing'), sys, 'enoent', 127],
          ['absolute, not runnable', join(bin, 'plain-cli'), sys, 'eacces', 126],
          ['absolute, a folder', join(bin, 'folder-cli'), sys, 'eacces', 126],
          ['absolute, runnable', join(bin, 'good-cli'), sys, '', 0],
          ['relative, not runnable', './bin/plain-cli', sys, 'eacces', 126],
          ['relative, missing', './bin/nothing', sys, 'enoent', 127],
          ['a name, missing', 'cc-no-such-cli', sys, 'enoent', 127],
          ['a name, missing, PATH unset', 'cc-no-such-cli', undefined, 'enoent', 127],
          ['a name, not runnable on PATH', 'plain-cli', `${sys}:${bin}`, 'eacces', 126],
          ['a name, a folder on PATH', 'folder-cli', `${sys}:${bin}`, 'eacces', 126],
          ['a name, not runnable on a relative PATH entry', 'plain-cli', `${sys}:bin`, 'eacces', 126],
          ['a name, not runnable behind an empty PATH entry', 'plain-cli', `${sys}:`, 'eacces', 126],
          ['a name, runnable on a relative PATH entry', 'good-cli', `${sys}:./bin`, '', 0],
          ['a name, runnable after a folder of that name', 'good-cli', `${bin}:${sys}`, '', 0],
          ['a name, runnable in the folder it starts in, PATH set but empty', 'good-cli', '', '', 0],
          ['a name, runnable after a file of that name that is not', 'good-cli', `${sys}:${join(dir, 'early')}:${bin}`, '', 0],
        ]
        for (const [what, command, PATH, said, status] of cases) {
          const cwd = what.includes('empty') ? bin : dir
          expect(say(shell, flags, prelude, command, cwd, PATH), `${label}: ${what}`).toEqual({ said, status })
        }
      })
    }
  })

  it('starts as before without it, and where there are no process groups', async () => {
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', "process.stdout.write(process.pid + '\\n')"], env: process.env })
    const pid = await helperPid(p.stdout)
    started.push(pid)
    expect(pid).toBe(p.pid)
  })
})
