import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = new URL('../.github/scripts/stop-leftover-apt.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const sleepBinary = process.platform === 'win32' ? '' : spawnSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim()
const hasPgrep = sleepBinary !== '' && spawnSync('pgrep', ['-x', 'nothing-by-this-name']).error === undefined

/*
 * #1503 (review of #1505): a `playwright install-deps` that hit its step limit is killed by the runner, but the root
 * `apt-get` it started goes on holding dpkg's locks, and the second try's `dpkg --configure -a` then fails at once.
 * The second try first runs this script. The stand-ins here are symlinks to the real `sleep` binary under a made-up name,
 * started by this test, so nothing of the machine's own is stopped. Not a script: pgrep -x reads the name of the
 * executable, which for a script is its interpreter (`bash`) on macOS, and it keeps at most 15 characters of it. Not a
 * copy either: macOS kills a copied platform binary at exec (code signing). A process is named after the path it was
 * exec'd by, not where a link leads, on both systems.
 */
describe.skipIf(!hasPgrep)('the second try of a browser install first stops what the first left running (#1503)', { timeout: 20_000 }, () => {
  const started: number[] = []
  const folders: string[] = []
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone already */
      }
    }
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A long-running process whose name is `name`; it ignores SIGTERM when `stubborn` */
  async function standIn(name: string, stubborn: boolean): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'stop-apt-'))
    folders.push(dir)
    const file = join(dir, name)
    symlinkSync(sleepBinary, file)
    // An ignored signal stays ignored through exec, so the stubborn one is the copy started by a shell that ignores SIGTERM
    const child = stubborn
      ? spawn('/bin/sh', ['-c', 'trap "" TERM; exec "$0" 1000', file], { stdio: 'ignore', detached: true })
      : spawn(file, ['1000'], { stdio: 'ignore', detached: true })
    started.push(child.pid!)
    // Until pgrep sees it by its name
    for (let i = 0; i < 100; i++) {
      if (spawnSync('pgrep', ['-x', name]).status === 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`${name} never started`)
  }
  /** Asynchronous: the stand-ins are children of this process, and a blocked event loop would not collect them once killed (a zombie still shows to pgrep) */
  const run = (name: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('bash', [script, name], { env: { ...process.env, SUDO: '', WAIT: '3' } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
  const alive = (name: string) => spawnSync('pgrep', ['-x', name]).status === 0

  it('asks what is left to stop, and returns once it is gone', async () => {
    const name = `fkapt${process.pid % 100000}a`
    await standIn(name, false)
    const r = await run(name)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain(`left ${name} running: stopping it`)
    // Gone on the request, not by the kill after the wait: with the SIGTERM step removed this would still end, by the fallback
    expect(r.stdout).not.toContain('did not stop in')
    expect(alive(name)).toBe(false)
  })

  it('kills what ignores the request, rather than leave the lock held', async () => {
    const name = `fkapt${process.pid % 100000}b`
    await standIn(name, true)
    const r = await run(name)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('did not stop in 3s: killing it')
    expect(alive(name)).toBe(false)
  })

  it('does nothing when nothing is left', async () => {
    const r = await run(`fkapt${process.pid % 100000}c`)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).not.toContain('stopping it')
  })
})
