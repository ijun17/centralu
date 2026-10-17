#!/usr/bin/env node
/**
 * The keeper end to end (#280, option C steps 1 and 3), with the real binary and the real host.
 *
 *   node scripts/keeper-integration.mjs [--no-build] [--only <scenario>[,<scenario>]]
 *
 * Builds the desktop binary with `cargo build` into a target folder under /tmp (never
 * `tauri build`, never anything under `target/release/bundle`), bundles the repository's host with
 * `pnpm bundle:host`, and runs `centralu-keeper --keeper` against a temporary `CC_DATA_DIR`. A
 * stand-in for the app attaches from a child process, so "the app dies" is a real SIGKILL of a real
 * process.
 *
 * Checked:
 *   - the keeper starts the host from a per-build copy under the data folder, not the bundle;
 *   - an attached client gets the host's port and token, and the host's WebSocket answers
 *     hello_ok with the build it came from;
 *   - a second keeper on the same folder defers to the first and starts no second host;
 *   - background off: killing the attached client stops the host and the keeper;
 *   - background on: killing it leaves both running, a new client re-attaches to the same host,
 *     a switch moves the host to another build and removes the old copy, and the keeper
 *     ends itself after the idle limit with nothing attached — but not while a terminal is open;
 *   - an announced relaunch ("Apply now", #352) with background off: the window closing stops
 *     nothing, the window that attaches within the grace is told it is the relaunched one and finds
 *     the same host and the same keeper-held terminal; without an announcement, or once the grace
 *     has run out with no window back, the keeper stops as before;
 *   - stop ends everything;
 *   - a keeper killed outright takes its host with it, and a new keeper takes the folder over;
 *   - a keeper started from `<data>/content/<version>/` closes the descriptors it inherited and
 *     drops the AppImage's variables, so neither it nor its host keeps an AppImage mounted (FI4,
 *     FI5); one started from anywhere else keeps them.
 *
 * Step 3 (the front door and the blue-green swap):
 *   - clients and the host's Codex bridge address are the front door's, not the host's own port,
 *     and the host gets the front door's token;
 *   - a swap closes connections through the door, the same address and token reach the new host
 *     after a reconnect, the attached app hears every phase, one host remains, running from the
 *     new build's copy, and the old copy is removed; a bridge process started before the swap
 *     reaches the new host on its next call, which accepts its session credential (#382);
 *   - a swap to a broken build fails its standby check and leaves the running host serving, its
 *     clients connected;
 *   - a new host that fails after the old one drained is reported, and the old build serves again;
 *   - the drain answers a slow call the host serves itself with a retryable error once the bound
 *     (shortened to 1.5 s here) has passed, and the swap reports what it cut.
 *
 * It needs no model and no network, and CI runs all of it (the `keeper` job in
 * `.github/workflows/build.yml`).
 *
 * Every process it starts, and everything those start, is killed before it exits, pass or fail
 * (`keeper-test-processes.mjs`); a failed scenario prints the end of its keeper's and host's logs.
 *
 * This file runs the scenarios; they live by topic in `keeper-integration-lifecycle.mjs`,
 * `keeper-integration-relaunch.mjs` and `keeper-integration-swap.mjs`, and what they share in
 * `keeper-integration-harness.mjs`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupOnExit } from './keeper-test-processes.mjs'
import { BIN, cleanup, countFailure, failures, HOST_SRC, log, ROOT, TARGET } from './keeper-integration-harness.mjs'
import { scenarioBackgroundOff, scenarioBackgroundOn, scenarioBusyHoldsIdle, scenarioKeeperDies, scenarioStop } from './keeper-integration-lifecycle.mjs'
import { scenarioFromACopy, scenarioRelaunch } from './keeper-integration-relaunch.mjs'
import { scenarioDrainCutsSlowCall, scenarioSwap } from './keeper-integration-swap.mjs'

async function main() {
  if (!process.argv.includes('--no-build')) {
    log('bundling the host (pnpm bundle:host)')
    execFileSync('pnpm', ['bundle:host'], { cwd: ROOT, stdio: 'inherit' })
    log(`building the binary (cargo build, CARGO_TARGET_DIR=${TARGET})`)
    const r = spawnSync('cargo', ['build', '--manifest-path', join(ROOT, 'apps/desktop/src-tauri/Cargo.toml')], {
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: TARGET },
    })
    if (r.status !== 0) throw new Error('cargo build failed')
  }
  if (!existsSync(BIN)) throw new Error(`no binary at ${BIN}`)
  if (!existsSync(join(HOST_SRC, 'main.mjs'))) throw new Error(`no bundled host at ${HOST_SRC}`)
  const scenarios = {
    'background-off': scenarioBackgroundOff,
    'background-on': scenarioBackgroundOn,
    stop: scenarioStop,
    relaunch: scenarioRelaunch,
    'busy-holds-idle': scenarioBusyHoldsIdle,
    'keeper-dies': scenarioKeeperDies,
    swap: scenarioSwap,
    drain: scenarioDrainCutsSlowCall,
    'from-a-copy': scenarioFromACopy,
  }
  const at = process.argv.indexOf('--only')
  const only = at >= 0 ? process.argv[at + 1].split(',') : Object.keys(scenarios)
  for (const name of only) {
    if (!scenarios[name]) throw new Error(`no scenario ${name}; there are ${Object.keys(scenarios).join(', ')}`)
    await scenarios[name]()
  }
}

cleanupOnExit(cleanup, log)
try {
  await main()
} catch (e) {
  countFailure()
  log(`\nerror: ${e?.stack ?? e}`)
  cleanup(true)
} finally {
  cleanup()
}
log(failures === 0 ? '\nall keeper checks passed' : `\n${failures} keeper check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
