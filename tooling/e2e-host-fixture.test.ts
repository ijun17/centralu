import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { SLOW } from './test-timing.js'
import { spawnHost } from '../e2e/fixtures/real-host.js'
import { alive } from '../packages/agent-host/src/process.test-helpers.js'

/*
 * The hosts the e2e starts (e2e/fixtures/real-host.ts, #1890). The linked-hosts scenario for a wake the link dropped under
 * stops the remote with SIGSTOP; a stopped process takes no signal but SIGKILL, so one that was never resumed outlived its
 * run: ten of them were found in state T hours later. SIGSTOP and SIGCONT do not exist on Windows.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const win = process.platform === 'win32'
const READY = `console.log(JSON.stringify({ ready: true })); setInterval(() => {}, 1000)`

describe.skipIf(win)('a host an e2e started and stopped with SIGSTOP', () => {
  it('is ended by kill, which asks for SIGTERM: the stop does not hold it back', async () => {
    const host = await spawnHost(['-e', READY], {}, 'stand-in host')
    try {
      host.child.kill('SIGSTOP')
      await host.kill()
      expect(host.child.signalCode).toBe('SIGTERM')
    } finally {
      host.child.kill('SIGKILL')
    }
  }, 30_000 * SLOW)

  it('is ended with the worker that started it, when that worker ends without stopping it', async () => {
    const script = `
      import { spawnHost } from './e2e/fixtures/real-host.ts'
      const host = await spawnHost(['-e', ${JSON.stringify(READY)}], {}, 'stand-in host')
      console.log('host ' + host.child.pid)
      host.child.kill('SIGSTOP')
      process.exit(0)
    `
    const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    worker.stdout.on('data', (d: Buffer) => (out += String(d)))
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    let pid = 0
    try {
      await exited
      pid = Number(/host (\d+)/.exec(out)?.[1])
      expect(pid).toBeGreaterThan(0)
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 20_000 * SLOW, interval: 100 })
    } finally {
      // Only while the number is still the stand-in's: the wait above saw it end, and then it is not ours to signal
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    }
  }, 60_000 * SLOW)
})
