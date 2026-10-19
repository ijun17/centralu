/**
 * `centralu serve --window` (#1223): what the desktop window on Windows runs in place of a host of its own when
 * `centralu serve` is installed in its data folder (`start_plan`'s `Host::Serve` in the window). One host per data
 * folder: a linked hub's serve holds this one, or will, so the window uses that host rather than start one the folder's
 * lock refuses.
 */
import { join } from 'node:path'
import { readServeState } from './serve-files.mjs'
import { DEFAULT_SERVE_PORT } from './serve-port.mjs'
import { hostProvesOf, probeHost, protocolVersionOf } from './serve-host.mjs'
import { serveFolder } from './serve-run.mjs'
import { runDetach } from './serve-detach.mjs'
import { startInSignIn } from './serve-autostart.mjs'
import { say, sleep } from './serve-util.mjs'

/**
 * Makes sure the folder's serve host runs, then prints the window's ready line, `{"ready":true,"port","token","db"}`
 * (the line a host the window starts prints), and stays until the window goes.
 *
 * - No host answers: one is started the way `--detach` starts it, in this Windows sign-in through the scheduled task,
 *   so it outlives the window and the hub's link finds it (`serve --connection`).
 * - A host in a network logon answers (the one the hub's ssh started before anyone signed in): the window uses it now,
 *   and the sign-in task is started, whose serve moves it into this sign-in once nothing runs there
 *   (`moveIntoSignIn`, serve-handover.mjs).
 * - stdin is the window (it runs this with stdin a pipe): when it ends, this exits 0 and leaves the host running,
 *   since it serves the hub's link too.
 * - The host stops answering for `misses` polls in a row (the hand-over's gap, or it ended): this exits 1, and the
 *   window's supervisor starts this again, which finds the new host or starts one.
 *
 * Resolves with the exit code. `detach`, `signIn`, `pollMs`, `misses` and `stdin` are parameters for tests.
 */
export async function runWindow({
  env,
  home,
  entry,
  version,
  cliPath,
  platform = process.platform,
  write = (line) => process.stdout.write(line),
  stdin = process.stdin,
  detach = runDetach,
  signIn = startInSignIn,
  pollMs = 5_000,
  misses = 3,
}) {
  const { dataDir } = serveFolder({ env, home, cliPath, platform })
  const prove = hostProvesOf(entry)
  const protocolVersion = protocolVersionOf(entry) ?? 0
  const probe = () => {
    const state = readServeState(dataDir)
    return state ? probeHost({ port: state.port ?? DEFAULT_SERVE_PORT, token: state.token, protocolVersion, prove }) : Promise.resolve({ running: false })
  }

  let host = await probe()
  if (!host.running) {
    say(`no Centralu host runs for ${dataDir}: starting one in this Windows sign-in, which keeps running for a linked hub when the window closes`)
    let answer = null
    await detach({ env, home, entry, version, cliPath, platform, write: (line) => (answer = line) })
    const d = parseLine(answer)
    if (!d?.hostRunning) {
      say(`could not start the host: ${d?.detach?.message ?? 'centralu serve --detach did not answer'}`)
      return 1
    }
    host = await probe()
    if (!host.running) {
      say('the host started, then did not answer')
      return 1
    }
  } else if (host.logon === 'network') {
    const s = await signIn({ dataDir, env, home, platform }).catch((e) => ({ started: false, reason: 'error', message: e.message }))
    say(
      s.started
        ? 'the host runs in a network logon (started over ssh): this window uses it, and it moves into this sign-in once nothing runs there'
        : `the host runs in a network logon (started over ssh), and could not be moved into this sign-in (${s.message ?? s.reason})`,
    )
  }

  const state = readServeState(dataDir)
  write(`${JSON.stringify({ ready: true, port: state.port ?? DEFAULT_SERVE_PORT, token: state.token, db: join(dataDir, 'store.db') })}\n`)

  return await new Promise((resolve) => {
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      resolve(code)
    }
    stdin.once('end', () => finish(0))
    stdin.once('close', () => finish(0))
    stdin.resume()
    void (async () => {
      let missed = 0
      while (!done) {
        await sleep(pollMs)
        if (done) return
        missed = (await probe()).running ? 0 : missed + 1
        if (missed >= misses) {
          say(`the host for ${dataDir} stopped answering; the window starts this again`)
          finish(1)
        }
      }
    })()
  })
}

function parseLine(text) {
  try {
    return JSON.parse(String(text ?? '').trim().split('\n').at(-1))
  } catch {
    return null
  }
}
