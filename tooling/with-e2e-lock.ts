/**
 * Runs a command while holding the e2e lock (tooling/e2e-lock.ts, #1632): how `pnpm e2e`, `pnpm ux`, `pnpm perf` and
 * `pnpm perf:memory` take it.
 *
 *   tsx tooling/with-e2e-lock.ts playwright test --config e2e/playwright.config.ts [playwright's own arguments]
 *   tsx tooling/with-e2e-lock.ts node --import tsx e2e/perf-memory.mts [its arguments]
 *
 * `playwright` is Playwright's own command line started with this Node (no shell, so no `.cmd` shim), `node` is this Node.
 * The command's exit code is this one's. A run that waits says who holds the lock. A SIGINT (Ctrl-C) or SIGTERM that
 * reaches this process:
 *  - while it waits: ends it with 130 or 143, having taken nothing;
 *  - while the command runs: is passed on to the command, and the lock is given back when the command has ended. The exit
 *    code is the command's own, except that a command a signal ended gives 128 plus its number (as a shell reports it), and
 *    one that was told to stop and then exited with 0 gives 130 or 143 too.
 * Windows has no signals. A console's Ctrl-C reaches every process on the console, the command too, so it is not passed on
 * there (`child.kill` would end Playwright outright, without its teardown and report): the runner waits for the command to
 * end and gives the lock back. Anything else that ends the runner there ends it outright, and nothing above runs.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { acquireLock, passesSignalOn, signalExit, trackChild, type Held } from './e2e-lock.js'

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
// Named in the lock at once, and its start time filled in as soon as it is known (on Windows that takes seconds): a runner
// killed in between must not leave Playwright running with the lock free
if (child.pid !== undefined) void trackChild(held, child.pid)
// Ctrl-C reaches the child itself on a terminal; a signal sent to this process alone is passed on (not on Windows: passesSignalOn)
let passedOn: 'SIGINT' | 'SIGTERM' | null = null
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    passedOn ??= signal
    if (passesSignalOn()) child.kill(signal)
  })
}
// A run that cannot be started gives the lock back before it fails
child.on('error', (err) => {
  held.release()
  console.error(`e2e lock: could not start ${program}: ${err.message}`)
  process.exit(1)
})
child.on('close', (exitCode, signal) => {
  held.release()
  process.exit(exitCode === null || (exitCode === 0 && passedOn !== null) ? signalExit(signal ?? passedOn) : exitCode)
})
