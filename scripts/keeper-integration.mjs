#!/usr/bin/env node
/**
 * The keeper end to end (#280, option C steps 1 and 3), with the real binary and the real host.
 *
 *   node scripts/keeper-integration.mjs [--no-build] [--only <scenario>[,<scenario>]] [--claude]
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
 *     `switch` answers `gone` and leaves the host serving (#1895 step 4, PR 4), and the keeper
 *     ends itself after the idle limit with nothing attached — but not while a terminal is open;
 *   - an update is a stop and continue (#1895): the keeper serves no child socket and takes no
 *     announced relaunch (`relaunching`, gone with step 4 PR 3); `stop` with
 *     `forUpdate` ends the host, every process it started and the keeper, and the host hears it on
 *     its stdin and leaves no quit mark; the keeper started next opens the terminal again and starts
 *     the dev server again; a host crash under it ends the processes the host started and reopens no
 *     terminal; with background mode on and no window attached the host keeps its own children
 *     running; stop ends the keeper, the host and its children and notes that the person quit.
 *     `--claude` adds a claude (`haiku`, a few cents) turn that the update cuts and the next host
 *     continues with Centralu's note, and one that the crash cuts, shown stopped and not continued;
 *   - stop ends everything;
 *   - a keeper killed outright takes its host with it, and a new keeper takes the folder over;
 *   - a keeper started from `<data>/content/<version>/` closes the descriptors it inherited and
 *     drops the AppImage's variables, so neither it nor its host keeps an AppImage mounted (FI4,
 *     FI5); one started from anywhere else keeps them.
 *
 * Step 3's front door (`keeper-integration-front-door.mjs`): clients and the host's Codex bridge address are the front
 * door's, not the host's own port, the host gets the front door's token on its stdin, and after a host crash the same
 * address and token reach the next host run. The blue-green swap and the keeper handoff went in #1895 step 4, PR 4, with their
 * scripts (`keeper-integration-swap.mjs`, `keeper-handoff-integration.mjs`, `keeper-content-integration.mts`).
 *
 * Without `--claude` it needs no model and no network, and CI runs all of it that way (the `keeper`
 * jobs in `.github/workflows/build.yml`).
 *
 * Every process it starts, and everything those start, is killed before it exits, pass or fail
 * (`keeper-test-processes.mjs`); a failed scenario prints the end of its keeper's and host's logs.
 *
 * This file runs the scenarios; they live by topic in `keeper-integration-lifecycle.mjs`,
 * `keeper-integration-relaunch.mjs` and `keeper-integration-front-door.mjs`, and what they share in
 * `keeper-integration-harness.mjs`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupOnExit } from './keeper-test-processes.mjs'
import { BIN, buildKeeper, cleanup, countFailure, failures, HOST_SRC, log } from './keeper-integration-harness.mjs'
import { scenarioBackgroundOff, scenarioBackgroundOn, scenarioBusyHoldsIdle, scenarioKeeperDies, scenarioStop } from './keeper-integration-lifecycle.mjs'
import { scenarioFromACopy, scenarioUpdate } from './keeper-integration-relaunch.mjs'
import { scenarioFrontDoor } from './keeper-integration-front-door.mjs'

// The clients here are this Node process, not a Centralu window: a debug keeper started with this also accepts its
// executable as a window's, so they get the token and may stop it for an update (#1405, keeper/window_peer.rs). A release
// keeper ignores it.
process.env.CC_KEEPER_TEST_WINDOW_EXE = process.execPath

async function main() {
  if (!process.argv.includes('--no-build')) {
    buildKeeper()
  }
  if (!existsSync(BIN)) throw new Error(`no binary at ${BIN}`)
  if (!existsSync(join(HOST_SRC, 'main.mjs'))) throw new Error(`no bundled host at ${HOST_SRC}`)
  const scenarios = {
    'background-off': scenarioBackgroundOff,
    'background-on': scenarioBackgroundOn,
    stop: scenarioStop,
    update: scenarioUpdate,
    'busy-holds-idle': scenarioBusyHoldsIdle,
    'keeper-dies': scenarioKeeperDies,
    'front-door': scenarioFrontDoor,
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
