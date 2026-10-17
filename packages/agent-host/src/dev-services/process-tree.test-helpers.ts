import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A real process tree for the Windows tree-kill tests (#849): a Node script that starts a copy of itself, which starts
 * another, each appending its pid to a file and then idling.
 *
 * Every copy below the first is started `detached`, so it is outside the job Node puts its own children in: a child in
 * that job ends with its parent whatever the host does, so it would pass a test of the host's tree kill without the
 * tree kill. A detached child has no console either, so a closing console (a pty's) does not reach it. It is what a
 * dev server or a non-Node tool started from a shell looks like to Windows: only its parent link leads to it, and only
 * `taskkill /T` follows that link.
 *
 * Every copy also ignores the hang-up (SIGHUP, which Node raises on Windows when its console closes), as a dev server
 * that cleans up on its own terms does.
 */
export function plantTreeScript(dir: string): string {
  const script = join(dir, 'tree.cjs')
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process')",
      "const { appendFileSync } = require('node:fs')",
      'const [pidFile, depth] = process.argv.slice(2)',
      "process.on('SIGHUP', () => {})",
      'if (Number(depth) > 0) {',
      "  spawn(process.execPath, [__filename, pidFile, String(Number(depth) - 1)], { detached: true, stdio: 'ignore', windowsHide: true }).unref()",
      '}',
      // After the spawn, so once the file holds every pid, every process in the tree has been started
      "appendFileSync(pidFile, process.pid + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n'),
  )
  return script
}

/**
 * Windows: the console hosts this process has started, by pid: one per pseudoconsole, `conhost.exe` for the ConPTY of
 * Windows and `OpenConsole.exe` for the one node-pty ships (#849). Through CIM, the one listing with the parent id.
 */
export function consoleHosts(): number[] {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND (Name='conhost.exe' OR Name='OpenConsole.exe')" | ForEach-Object { $_.ProcessId }`
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  return out.split(/\r?\n/).filter(Boolean).map(Number)
}

/** Windows: this process's threads, handles and private memory (MB), as Task Manager counts them */
export function processCounters(): { threads: number; handles: number; privateMb: number } {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const query = `$p = Get-Process -Id ${process.pid}; "$($p.Threads.Count) $($p.HandleCount) $($p.PrivateMemorySize64)"`
  const [threads, handles, bytes] = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    .trim()
    .split(/\s+/)
    .map(Number)
  return { threads: threads!, handles: handles!, privateMb: Math.round(bytes! / 1048576) }
}

/** The pids the tree has written so far */
export function treePids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return []
  return readFileSync(pidFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until the condition holds and returns the last value read; never throws, so the assertion after it names what was left */
export async function settle<T>(read: () => T, ok: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  let v = read()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
    v = read()
  }
  return v
}

/**
 * Ends whatever a failed test left running (only pids the test's own tree wrote) and waits for it to be gone: Windows
 * refuses to remove a folder a running process works in.
 */
export async function cleanUp(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
  await settle(() => pids.filter(alive), (left) => left.length === 0, 5_000)
}
