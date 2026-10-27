/**
 * Runs a command while holding the e2e lock (tooling/e2e-lock.ts, #1632): how `pnpm e2e`, `pnpm ux`, `pnpm perf` and
 * `pnpm perf:memory` take it.
 *
 *   tsx tooling/with-e2e-lock.ts playwright test --config e2e/playwright.config.ts [playwright's own arguments]
 *   tsx tooling/with-e2e-lock.ts node --import tsx e2e/perf-memory.mts [its arguments]
 *
 * `playwright` is Playwright's own command line started with this Node (no shell, so no `.cmd` shim), `node` is this Node.
 * The command's exit code is this one's; a command ended by a signal gives 128 plus its number (137 for SIGKILL), as a
 * shell reports it. A run that waits says who holds the lock; Ctrl-C or a SIGTERM while waiting or running ends both
 * and gives the lock back (130 and 143).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { acquireLock, processStartTime, type Held } from './e2e-lock.js'

/** What a shell reports for a process a signal ended: 128 plus the signal's number */
const signalExit = (signal: string | null): number => 128 + ((signal !== null && (constants.signals as Record<string, number | undefined>)[signal]) || 1)

const [program, ...args] = process.argv.slice(2)
if (program !== 'playwright' && program !== 'node') {
  console.error('usage: with-e2e-lock.ts playwright <playwright arguments> | with-e2e-lock.ts node <node arguments>')
  process.exit(2)
}
const argv = program === 'playwright' ? [createRequire(import.meta.url).resolve('@playwright/test/cli'), ...args] : args

const waiting = new AbortController()
let stoppedBy: 'SIGINT' | 'SIGTERM' | null = null
const stopWaiting = (signal: 'SIGINT' | 'SIGTERM') => () => {
  stoppedBy = signal
  waiting.abort()
}
const onInt = stopWaiting('SIGINT')
const onTerm = stopWaiting('SIGTERM')
process.once('SIGINT', onInt)
process.once('SIGTERM', onTerm)

let held: Held
try {
  held = await acquireLock({ command: [program, ...args].join(' '), signal: waiting.signal })
} catch (err) {
  console.error(`e2e lock: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(stoppedBy === null ? 1 : signalExit(stoppedBy))
}
process.off('SIGINT', onInt)
process.off('SIGTERM', onTerm)
console.error('e2e lock: taken')

const child = spawn(process.execPath, argv, { stdio: 'inherit' })
// Named in the lock at once, before its start time is looked up (which can take a second): a runner killed in between
// must not leave Playwright running with the lock free. The start time is filled in as soon as it is known.
if (child.pid !== undefined) {
  const pid = child.pid
  held.setChild({ pid, started: null })
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
  process.exit(exitCode ?? signalExit(signal))
})
