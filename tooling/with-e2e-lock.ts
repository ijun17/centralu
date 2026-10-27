/**
 * Runs a command while holding the e2e lock (tooling/e2e-lock.ts, #1632): how `pnpm e2e`, `pnpm ux`, `pnpm perf` and
 * `pnpm perf:memory` take it.
 *
 *   tsx tooling/with-e2e-lock.ts playwright test --config e2e/playwright.config.ts [playwright's own arguments]
 *   tsx tooling/with-e2e-lock.ts node --import tsx e2e/perf-memory.mts [its arguments]
 *
 * `playwright` is Playwright's own command line started with this Node (no shell, so no `.cmd` shim), `node` is this Node.
 * The command's exit code is this one's. A run that waits says who holds the lock; Ctrl-C while waiting or running ends
 * both and gives the lock back.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { acquireLock, processStartTime, type Held } from './e2e-lock.js'

const [program, ...args] = process.argv.slice(2)
if (program !== 'playwright' && program !== 'node') {
  console.error('usage: with-e2e-lock.ts playwright <playwright arguments> | with-e2e-lock.ts node <node arguments>')
  process.exit(2)
}
const argv = program === 'playwright' ? [createRequire(import.meta.url).resolve('@playwright/test/cli'), ...args] : args

const waiting = new AbortController()
const stopWaiting = () => waiting.abort()
process.once('SIGINT', stopWaiting)
process.once('SIGTERM', stopWaiting)

let held: Held
try {
  held = await acquireLock({ command: [program, ...args].join(' '), signal: waiting.signal })
} catch (err) {
  console.error(`e2e lock: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(130)
}
process.off('SIGINT', stopWaiting)
process.off('SIGTERM', stopWaiting)
console.error('e2e lock: taken')

const child = spawn(process.execPath, argv, { stdio: 'inherit' })
// The lock names the child too, so that it is not free while a child runs on after a runner that was killed
if (child.pid !== undefined) {
  const pid = child.pid
  setImmediate(() => held.setChild({ pid, started: processStartTime(pid) }))
}
// Ctrl-C reaches the child itself on a terminal; a signal sent to this process alone is passed on
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
// A run that cannot be started gives the lock back before it fails
child.on('error', (err) => {
  held.release()
  console.error(`e2e lock: could not start ${program}: ${err.message}`)
  process.exit(1)
})
child.on('close', (exitCode, signal) => {
  held.release()
  process.exit(exitCode ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))
})
