import type { Readable } from 'node:stream'
import { ownProcesses } from '../process.test-helpers.js'

/**
 * A stand-in for an agent CLI that starts a helper of its own, the way Claude Code's LSP tool starts
 * `typescript-language-server` (which starts `tsserver`), or an MCP server from the user's config.
 * The helper is an ordinary child: it shares the CLI's process group and is never stopped by the
 * CLI, so a CLI that ends leaves it behind unless whoever stops the CLI reaches it too.
 *
 * On Windows the helper is started `detached`. A child Node starts there otherwise joins Node's
 * kill-on-close job and dies with the CLI whatever the host does, so the fake would prove nothing;
 * detached, it stands for a helper started outside that job (by a native CLI, a Python MCP server),
 * which only the host's own cleanup ends. Elsewhere it stays in the CLI's process group.
 *
 * The CLI prints the helper's pid as its first line, then:
 *   - `ignoreTerm`: both it and its helper ignore SIGTERM, so only SIGKILL ends them;
 *   - `crash`: it exits by itself once the helper is up (no one asked it to stop);
 *   - otherwise it waits, and exits on stdin EOF.
 */
export function fakeAgentCli(opts: { ignoreTerm?: boolean; crash?: boolean; pidFile?: string } = {}): { command: string; args: string[] } {
  const ignore = opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : ''
  const toFile = opts.pidFile ? `require('node:fs').writeFileSync(${JSON.stringify(opts.pidFile)}, String(helper.pid));` : ''
  const script = [
    "const { spawn } = require('node:child_process')",
    ignore,
    // The pid is given once the helper runs its script, so a signal never finds it half started
    `const helper = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignore}console.log('up'); setInterval(() => {}, 1000)`)}], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform === 'win32' })`,
    // A crash comes once the pid is out, however long the helper took to start
    `helper.stdout.once('data', () => { ${toFile} process.stdout.write(helper.pid + '\\n'); helper.stdout.destroy(); ${opts.crash ? 'setTimeout(() => process.exit(3), 100)' : ''} })`,
    "process.stdin.on('end', () => process.exit(0))",
    'process.stdin.resume()',
    'setInterval(() => {}, 1000)',
  ].join('\n')
  return { command: process.execPath, args: ['-e', script] }
}

/** The helper's pid: the CLI's first line */
export function helperPid(stdout: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    let got = ''
    const t = setTimeout(() => reject(new Error(`the fake CLI printed no pid: ${got}`)), 10_000)
    const onData = (d: Buffer | string) => {
      got += d.toString()
      const nl = got.indexOf('\n')
      if (nl < 0) return
      clearTimeout(t)
      stdout.off('data', onData)
      const pid = Number(got.slice(0, nl).trim())
      seen.forget([pid])
      resolve(pid)
    }
    stdout.on('data', onData)
  })
}

/**
 * What this file's tests have seen end, which `killLeftovers` leaves alone: once a process is gone its number is free,
 * and ending it again would end whatever program has been given the number since (#1308)
 */
const seen = ownProcesses()

/** Whether the process exists; a process found gone is not ended again by `killLeftovers` */
export const alive = (pid: number): boolean => seen.alive(pid)

/**
 * A CLI this test started: the pid to give `killLeftovers`, which is left alone once the CLI has exited. Its handle
 * tells the end; asking `alive` after the fact cannot tell it from a program that has the number now.
 */
export function ownCli(cli: { pid?: number; once(event: 'exit', listener: () => void): unknown }): number {
  const pid = cli.pid!
  seen.forget([pid])
  cli.once('exit', () => seen.sawEnd(pid))
  return pid
}

/** A pid read from a file: a process this test started, whatever the number was before. Give it to `killLeftovers` */
export function ownPid(pid: number): number {
  seen.forget([pid])
  return pid
}

/** Waits for the process to be gone, up to `ms`. Returns whether it is */
export async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return !alive(pid)
}

/** Ends what a test started that the code under test should have ended, so a failing test leaves nothing running */
export function killLeftovers(pids: number[]): void {
  const left = pids.splice(0)
  seen.end(left)
  seen.forget(left)
}
