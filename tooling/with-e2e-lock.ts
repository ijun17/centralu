/**
 * Runs a command while holding the e2e lock (tooling/e2e-lock.ts, #1632): how `pnpm e2e`, `pnpm ux`, `pnpm perf` and
 * `pnpm perf:memory` take it.
 *
 *   tsx tooling/with-e2e-lock.ts playwright test --config e2e/playwright.config.ts [playwright's own arguments]
 *   tsx tooling/with-e2e-lock.ts playwright test --config e2e/playwright.config.ts --affected [playwright's own arguments]
 *   tsx tooling/with-e2e-lock.ts node --import tsx e2e/perf-memory.mts [its arguments]
 *
 * `playwright` is Playwright's own command line started with this Node (no shell, so no `.cmd` shim), `node` is this Node.
 * `--affected` runs the specs the branch changed in each engine (tooling/e2e-affected.ts), one run after the other, under
 * the one lock. The exit code is the command's own; of several runs, the first failing one's. A run that waits says who
 * holds the lock. A SIGINT (Ctrl-C) or SIGTERM that reaches this process:
 *  - while it waits: ends it with 130 or 143, having taken nothing;
 *  - while the command runs: is passed on to the command, no further run starts, and the lock is given back when the
 *    command has ended. The exit code is the command's own, except that a command a signal ended gives 128 plus its
 *    number (as a shell reports it), and one that was told to stop and then exited with 0 gives 130 or 143 too.
 * Windows has no signals. A console's Ctrl-C reaches every process on the console, the command too, so it is not passed on
 * there (`child.kill` would end Playwright outright, without its teardown and report): the runner waits for the command to
 * end and gives the lock back. Anything else that ends the runner there ends it outright, and nothing above runs.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { AFFECTED, affectedArgs, affectedEngines, engineOutput, listedCount, mergeBase, noSpecLines, reachesScreen } from './e2e-affected.js'
import { acquireLock, passesSignalOn, signalExit, trackChild, withoutSeparator, type Held } from './e2e-lock.js'

const [program, ...rest] = process.argv.slice(2)
const args = withoutSeparator(rest)
if (program !== 'playwright' && program !== 'node') {
  console.error('usage: with-e2e-lock.ts playwright <playwright arguments> | with-e2e-lock.ts node <node arguments>')
  process.exit(2)
}
const affected = program === 'playwright' && args.includes(AFFECTED)
const base = affected ? mergeBase() : null
if (affected && !base) {
  console.error(`e2e: ${AFFECTED} needs origin/main in this checkout, to know what the branch changed`)
  process.exit(2)
}
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
const commandArgs = base ? affectedArgs(args, base) : args
const argv = program === 'playwright' ? [cli, ...commandArgs] : commandArgs

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
// Ctrl-C reaches the child itself on a terminal; a signal sent to this process alone is passed on (not on Windows: passesSignalOn).
// Listened for before the wait's listeners go: with none, a signal ends this process by the OS's default, and the command it
// started keeps running with the lock given up (the macOS rehearsal of 0.1.0-beta.43). One that comes before the command has
// started is passed on once it has.
let child: ReturnType<typeof spawn> | null = null
let passedOn: 'SIGINT' | 'SIGTERM' | null = null
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    passedOn ??= signal
    if (passesSignalOn()) child?.kill(signal)
  })
}
process.off('SIGINT', onInt)
process.off('SIGTERM', onTerm)
console.error('e2e lock: taken')

/** Runs the command once, with `more` arguments and `env` added; answers its exit code, as this process would report it. */
function runOnce(more: string[] = [], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [...argv, ...more], { stdio: 'inherit', env: { ...process.env, ...env } })
    if (passedOn !== null && passesSignalOn()) child.kill(passedOn)
    // Named in the lock at once, and its start time filled in as soon as it is known (on Windows that takes seconds): a runner
    // killed in between must not leave Playwright running with the lock free. Awaited before the next run starts, so a late
    // answer about this one never names it over the next
    const tracking = child.pid === undefined ? Promise.resolve() : trackChild(held, child.pid)
    // A run that cannot be started gives the lock back before it fails
    child.on('error', (err) => {
      held.release()
      console.error(`e2e lock: could not start ${program}: ${err.message}`)
      process.exit(1)
    })
    child.on('close', (exitCode, signal) => {
      const code = exitCode === null || (exitCode === 0 && passedOn !== null) ? signalExit(signal ?? passedOn) : exitCode
      void tracking.then(() => resolve(code))
    })
  })
}

let code = 0
if (!base) code = await runOnce()
else {
  // The listing loads the config and the specs and starts nothing: whether any spec is picked, before an engine is started for none
  const listing = spawnSync(process.execPath, [...argv, '--list'], { encoding: 'utf8' })
  if (listedCount(`${listing.stdout}${listing.stderr}`) === 0) for (const line of noSpecLines(base, reachesScreen(base))) console.error(line)
  else {
    for (const engine of affectedEngines()) {
      if (passedOn !== null) break
      console.error(`e2e: the affected specs in ${engine}`)
      const ran = await runOnce([engineOutput(commandArgs, engine)], { E2E_BROWSER: engine })
      if (code === 0) code = ran
    }
  }
}
held.release()
process.exit(code)
