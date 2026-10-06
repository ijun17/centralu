import type { Readable } from 'node:stream'

/**
 * A stand-in for an agent CLI that starts a helper of its own, the way Claude Code's LSP tool starts
 * `typescript-language-server` (which starts `tsserver`), or an MCP server from the user's config.
 * The helper is an ordinary child: it shares the CLI's process group and is never stopped by the
 * CLI, so a CLI that ends leaves it behind unless whoever stops the CLI reaches it too.
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
    `const helper = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignore}console.log('up'); setInterval(() => {}, 1000)`)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
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
      resolve(Number(got.slice(0, nl).trim()))
    }
    stdout.on('data', onData)
  })
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Waits for the process to be gone, up to `ms`. Returns whether it is */
export async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return !alive(pid)
}

/** Ends what a test started that the code under test should have ended, so a failing test leaves nothing running */
export function killLeftovers(pids: number[]): void {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
