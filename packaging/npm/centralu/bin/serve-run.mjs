/** `centralu serve` in the foreground, `--connection` and `--rotate-token` */
import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isAlive, say } from './serve-util.mjs'
import { SERVE_STATE_FILE, SERVE_PID_FILE, readStopped, serveDataDir, ensureServeState, recordServePort, rotateServeToken, heldHere, lockHolder, lockHolderPid, removeServePid } from './serve-files.mjs'
import { DEFAULT_SERVE_PORT, SERVE_PORT_TRIES, chooseServePort, listensHere, windowsListening } from './serve-port.mjs'
import { keepLauncher, installInfo } from './serve-install.mjs'
import { protocolVersionOf, connectionLine, hostEnv, hostCommand, readyPort, hostProvesOf, probeHost, serveFrom, takesTokenOnStdin, tokenLine } from './serve-host.mjs'
import { autostartInfo } from './serve-autostart.mjs'
import { moveIntoSignIn } from './serve-handover.mjs'

/**
 * The data folder a command that may start or describe a host works in: its state, created on first use, and the
 * launcher serve keeps there brought up to date (`keepLauncher`).
 */
export function serveFolder({ env, home, cliPath, platform = process.platform }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir, platform)
  keepLauncher(dataDir, cliPath, env)
  return { dataDir, state }
}

/** What `--connection` answers, as fields: the running host's versions when one answers, else the installed ones */
export async function describe({ env, dataDir, state, entry, version }) {
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry)
  // Whether the installed host proves it holds the token (#838): asked of the running one before its hello, and said in the line
  const proof = hostProvesOf(entry)
  const probe = await probeHost({ port, token: state.token, protocolVersion: installed, prove: proof })
  const protocolVersion = (probe.running ? probe.protocolVersion : undefined) ?? installed
  if (protocolVersion === null) return null
  const hostRunning = heldHere(probe, dataDir)
  // The person stopped it here (#1143): said while no host runs, so a hub starts none by itself
  const stopped = hostRunning ? null : readStopped(dataDir)
  return {
    proof,
    port,
    token: state.token,
    version: (probe.running ? probe.version : undefined) ?? version,
    protocolVersion,
    dataDir,
    hostRunning,
    install: installInfo(dataDir, env),
    autostart: autostartInfo(dataDir, process.platform, env),
    ...(stopped ? { stopped } : {}),
  }
}

/**
 * `centralu serve --connection`. stdout carries exactly one line, the JSON; everything else goes to
 * stderr. Exit 1 when there is no host to describe.
 */
export async function printConnection({ env, home, entry, version, cliPath }) {
  const { dataDir, state } = serveFolder({ env, home, cliPath })
  const d = await describe({ env, dataDir, state, entry, version })
  if (!d) {
    say(`cannot read the protocol version of the host at ${entry}`)
    return 1
  }
  process.stdout.write(`${connectionLine(d)}\n`)
  return 0
}

/**
 * `centralu serve`. Resolves with the exit code once the host has exited.
 *
 * The host's stdout is read here and never passed on: its ready line carries the token, which is
 * printed nowhere but `--connection`. Every other line the host writes to stdout (a lock conflict,
 * a store from a newer build) it also writes to stderr, which is passed through untouched.
 *
 * `logFd` is serve.log of a detached launcher (`runDetachedChild`): the host's stderr goes there
 * until it is ready, so a host that dies while starting (a native module that does not load, a store
 * from a newer build) says why in a file `--detach` can quote. From then on host.log has every line,
 * and serve.log stops growing.
 */
export async function runServe({ env, home, entry, version, cliPath, port: askedPort, from = null, platform = process.platform, execPath = process.execPath, logFd = null, handOver = moveIntoSignIn }) {
  const { dataDir, state } = serveFolder({ env, home, cliPath, platform })
  const protocolVersion = protocolVersionOf(entry)

  // A serve that is already up answers on the port it recorded; say so before starting a host that
  // would only fail on the data folder's lock with a less specific message.
  const recorded = state.port ?? DEFAULT_SERVE_PORT
  const existing = await probeHost({ port: recorded, token: state.token, protocolVersion, prove: hostProvesOf(entry) })
  // A host the hub's ssh started before anyone signed in moves into this sign-in, once idle (#1224, serve-handover.mjs)
  if (heldHere(existing, dataDir) && !(await handOver({ dataDir, entry, env, existing, platform }))) {
    const pid = lockHolderPid(dataDir)
    say(`centralu serve is already running for ${dataDir} on 127.0.0.1:${recorded}${pid ? ` (pid ${pid})` : ''}. Not starting a second one.`)
    return 1
  }

  const onWindows = await windowsListening(env, platform)
  const chosen = await chooseServePort({ asked: askedPort, recorded: state.port, taken: async (p) => onWindows.has(p) || (await listensHere(p)) })
  if (chosen === null) {
    say(`another program listens on 127.0.0.1:${recorded} and on the ${SERVE_PORT_TRIES - 1} ports above it. Give a free one with --port <n>.`)
    return 1
  }
  const port = chosen.port
  if (chosen.from !== null) {
    const who = onWindows.has(chosen.from) ? 'Windows' : 'another program'
    say(`127.0.0.1:${chosen.from} is in use by ${who}; starting on ${port} instead (kept for the next start)`)
  }

  const plan = hostCommand(execPath, entry, { port, dataDir, platform })
  const onStdin = takesTokenOnStdin(entry)
  const child = spawn(plan.command, plan.args, {
    stdio: ['pipe', 'pipe', logFd === null ? 'inherit' : 'pipe'],
    env: hostEnv(env, { dataDir, version, hostDir: dirname(entry), from: serveFrom(env, from), ...(onStdin ? {} : { legacyToken: state.token }) }),
    detached: plan.detached,
    windowsHide: true,
  })
  // The token, before anything else on the pipe the host watches (#538); stdin stays open for --watch-parent
  if (onStdin) child.stdin.write(tokenLine(state.token))

  let ready = false
  if (logFd !== null) {
    // Read to the end in any case: a pipe nobody drains stops the host once its buffer is full
    child.stderr.on('data', (b) => {
      if (ready) return
      try {
        writeSync(logFd, b)
      } catch {
        // the log is a convenience
      }
    })
  }
  if (child.pid) {
    try {
      writeFileSync(join(dataDir, SERVE_PID_FILE), `${JSON.stringify({ pid: process.pid, hostPid: child.pid, port })}\n`)
    } catch (e) {
      say(`could not write ${SERVE_PID_FILE}: ${e.message}`)
    }
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const p = readyPort(line)
    if (p === null || ready) return
    ready = true
    try {
      recordServePort(dataDir, p, platform)
    } catch (e) {
      say(`could not record the port in ${join(dataDir, SERVE_STATE_FILE)}: ${e.message}`)
    }
    say(`listening on 127.0.0.1:${p} (Centralu ${version}, protocol ${protocolVersion ?? 'unknown'}, data ${dataDir})`)
    if (logFd === null) say(`from your computer: ssh -N -L ${p}:127.0.0.1:${p} <this machine>, or let the app connect over SSH`)
    else say(`the host's own log continues in ${join(dataDir, 'host.log')}`)
  })

  /*
   * One signal to the host alone, whatever reached this launcher. SIGHUP (the terminal closed) is
   * passed as SIGTERM: the host has no SIGHUP handler, and Node's default for it is to exit on the
   * spot, skipping the shutdown that stops the agents. A second signal changes nothing on the host
   * side (its shutdown runs once), so forwarding every one is safe.
   */
  const forward = (sig) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (platform === 'win32') return // the host shares the console and received Ctrl+C itself
    try {
      child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig)
    } catch {
      // already gone
    }
  }
  const signals = platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, forward)

  return await new Promise((resolve) => {
    child.on('error', (e) => {
      removeServePid(dataDir, process.pid)
      say(`could not start the host (${plan.command}): ${e.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      for (const s of signals) process.off(s, forward)
      removeServePid(dataDir, process.pid)
      if (!ready && code !== 0) {
        const holder = lockHolder(dataDir)
        if (holder && holder.pid !== child.pid && isAlive(holder.pid)) {
          // Who it is, when its host.lock says (#1223)
          const who = { app: 'the Centralu window on this machine', keeper: "Centralu's keeper on this machine", serve: 'another centralu serve' }[holder.by] ?? 'probably the Centralu app on this machine'
          say(`the host did not start. ${dataDir} belongs to another Centralu host (pid ${holder.pid}), ${who}. Quit it, or point CC_DATA_DIR at another folder.`)
        }
      }
      if (logFd !== null) say(`the host exited (${signal ?? code})`)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

/** `centralu serve --rotate-token` */
export function rotateToken({ env, home }) {
  const dataDir = serveDataDir(env, home)
  rotateServeToken(dataDir)
  say(`replaced the token in ${join(dataDir, SERVE_STATE_FILE)}.`)
  say('A serve that is running keeps the old one until it restarts; clients read the new one with --connection.')
  return 0
}
