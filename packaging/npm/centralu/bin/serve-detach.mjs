/**
 * `centralu serve --detach` and `--stop`: starting serve outside the ssh session that asked, and
 * stopping it in order (docs/plans/remote-hub.md §10.4).
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, renameSync, writeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { answerLine, isAlive, say, sayTo, runCaptured, tail, sleep, waitUntil } from './serve-util.mjs'
import { SERVE_LOG_FILE, serveDataDir, readServeState, ensureServeState, heldHere, lockHolderPid, readServePid } from './serve-files.mjs'
import { askPowershell, detachHow, windowsArg, wmiScript, parseWmiAnswer, wmiBlockedMessage, windowsPowershell, windowsTool, wslDistro, wslUser } from './serve-windows.mjs'
import { DEFAULT_SERVE_PORT } from './serve-port.mjs'
import { CHILD_FLAG } from './serve-args.mjs'
import { protocolVersionOf, connectionLine, hostProvesOf, probeHost, askHostToStop } from './serve-host.mjs'
import { describe, runServe, serveFolder } from './serve-run.mjs'

/**
 * What a detached launcher needs from the `--detach` that started it. A process created through WMI
 * does not inherit this environment: it gets the account's default one. Everything else it needs
 * (the token, the port) is in the data folder. Never a secret.
 */
export const CARRIED_ENV = ['CC_DATA_DIR', 'CENTRALU_HOST_ENTRY', 'CENTRALU_MANAGED']

export function encodeChildSpec({ env, log }) {
  const carried = {}
  for (const k of CARRIED_ENV) if (typeof env[k] === 'string' && env[k]) carried[k] = env[k]
  return Buffer.from(JSON.stringify({ log, env: carried }), 'utf8').toString('base64url')
}

/** `{ log, env }` from `--detached-child=`, only the carried variables; null when it is not one */
export function decodeChildSpec(raw) {
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (typeof v?.log !== 'string' || !v.log) return null
    const env = {}
    for (const k of CARRIED_ENV) if (typeof v.env?.[k] === 'string') env[k] = v.env[k]
    return { log: v.log, env }
  } catch {
    return null
  }
}

/**
 * Starts the launcher outside this session (`detachHow`). `{ ok: true, pid, exited?, alive? }` once
 * something was created, `{ ok: false, blocked, message }` when nothing was: `blocked` is the WMI
 * refusal the hub falls back from.
 */
export async function startDetached({ how, execPath, args, env, cwd }) {
  if (how === 'setsid') {
    return await new Promise((resolve) => {
      let child
      try {
        child = spawn(execPath, args, { detached: true, stdio: 'ignore', cwd, env, windowsHide: true })
      } catch (e) {
        return resolve({ ok: false, blocked: false, message: `could not start ${execPath}: ${e.message}` })
      }
      child.once('error', (e) => resolve({ ok: false, blocked: false, message: `could not start ${execPath}: ${e.message}` }))
      child.once('spawn', () => {
        const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal ?? code)))
        child.unref()
        resolve({ ok: true, pid: child.pid, exited })
      })
    })
  }
  const ps = windowsPowershell(how, env)
  if (!ps) return { ok: false, blocked: true, message: wmiBlockedMessage('Windows PowerShell is not reachable from this WSL distro') }
  let commandLine
  try {
    if (how === 'wmi') commandLine = [execPath, ...args].map(windowsArg).join(' ')
    else {
      const distro = wslDistro(env.WSL_DISTRO_NAME ?? '')
      const user = wslUser(userInfo().username)
      commandLine = ['wsl.exe', '-d', distro, '-u', user, '--cd', cwd, '--exec', execPath, ...args].map(windowsArg).join(' ')
    }
  } catch (e) {
    return { ok: false, blocked: false, message: e.message }
  }
  const script = wmiScript({ commandLine, cwd: how === 'wmi' ? cwd : null })
  const answer = await askPowershell(ps, script, env, parseWmiAnswer)
  if (!answer.ok) return { ok: false, blocked: true, message: wmiBlockedMessage(answer.message) }
  // A Windows pid can be watched from Windows; from inside WSL it names nothing here
  /*
   * Measured on a Windows 11 laptop (2026-10-08): a `wsl.exe` that WMI creates can hang without
   * running anything in the distro (it starts a second wsl.exe and waits), while `wsl.exe --list`
   * from the same context answers. `--detach` reports that as a start that never ran, and ends what
   * it created rather than leave it waiting: this pid and its children, nothing else.
   */
  const taskkill = windowsTool(how, env, ['System32', 'taskkill.exe'])
  const stop = taskkill ? () => runCaptured(taskkill, ['/PID', String(answer.pid), '/T', '/F'], env) : null
  return { ok: true, pid: answer.pid, alive: how === 'wmi' ? () => isAlive(answer.pid) : null, stop }
}

/**
 * `centralu serve --detach` (docs/plans/remote-hub.md §10.4, S9): starts `serve` outside this
 * session (`detachHow`) and returns once its host answers a hello, so the caller, typically the
 * hub over ssh, can connect at once.
 *
 * stdout carries one JSON line, read by the hub (`links/tunnel.ts`): the connection line with
 * `hostRunning: true` and `detach: { ok: true, how, already }`, or `{ v: 1, detach: { ok: false,
 * how, reason, message } }`. `reason` is `wmi_blocked` when WMI created nothing or created something
 * that never ran, which the hub answers with a link-bound start; `exited` and `timeout` quote the
 * end of serve.log. Exit codes do not survive Windows' ssh (agent-host.md §4.8), so the line is
 * what counts; the exit code is 0 or 1 for a person at a prompt.
 *
 * `start` and the two waits are parameters so tests can stand in for WMI.
 */
export async function runDetach({
  env,
  home,
  entry,
  version,
  cliPath,
  port = null,
  platform = process.platform,
  execPath = process.execPath,
  cwd = process.cwd(),
  start = startDetached,
  how = detachHow(platform, env),
  timeoutMs = 30_000,
  noStartMs = 10_000,
  write = (line) => process.stdout.write(line),
}) {
  // Created here, so the token exists before the launcher reads it and `answered` reads it again
  const { dataDir } = serveFolder({ env, home, cliPath, platform })
  const fail = (reason, message) => answerLine(write, 'detach', { ok: false, how, reason, message })
  const answered = async (already) => {
    const d = await describe({ env, dataDir, state: ensureServeState(dataDir, platform), entry, version })
    if (!d?.hostRunning) return false
    write(`${connectionLine({ ...d, detach: { ok: true, how, already } })}\n`)
    return true
  }
  if (await answered(true)) return 0

  const log = join(dataDir, SERVE_LOG_FILE)
  // One start per log: the last one's is kept beside it, and its absence is how a start that never ran shows
  try {
    renameSync(log, `${log}.1`)
  } catch {
    // there was none
  }
  const args = [cliPath, 'serve', ...(port !== null ? ['--port', String(port)] : []), `${CHILD_FLAG}${encodeChildSpec({ env, log })}`]
  let started
  try {
    started = await start({ how, execPath, args, env, cwd })
  } catch (e) {
    return fail('failed', `could not start centralu serve in the background: ${e.message}`)
  }
  if (!started.ok) return fail(started.blocked ? 'wmi_blocked' : 'failed', started.message)
  say(`started centralu serve in the background (${how}, pid ${started.pid ?? 'unknown'}); waiting for its host`)

  let exited
  started.exited?.then((c) => (exited = c ?? 'unknown'))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await answered(false)) return 0
    const why = tail(log)
    if (exited !== undefined) return fail('exited', `centralu serve exited (${exited}) before its host answered${why ? `:\n${why}` : ''}`)
    const gone = started.alive?.() === false
    if (how !== 'setsid' && !existsSync(log) && (gone || Date.now() - t0 > noStartMs)) {
      // WMI said yes, and nothing ran: the process was stopped before Node started, or hangs (`startDetached`)
      if (!gone) await started.stop?.()
      return fail('wmi_blocked', wmiBlockedMessage(gone ? `process ${started.pid} ended before it started` : `nothing started within ${Math.round(noStartMs / 1000)} s`))
    }
    if (gone) return fail('exited', `centralu serve exited before its host answered${why ? `:\n${why}` : ''}`)
    await sleep(250)
  }
  const why = tail(log)
  return fail('timeout', `the host did not answer within ${Math.round(timeoutMs / 1000)} s${why ? `:\n${why}` : ''}`)
}

/**
 * The launcher `--detach` started: `runServe` writing to serve.log. The carried variables are
 * already in `env` (centralu.mjs merges them before it looks for the host).
 */
export async function runDetachedChild({ spec, ...opts }) {
  let fd = null
  try {
    fd = openSync(spec.log, 'a')
    sayTo((text) => {
      try {
        writeSync(fd, text)
      } catch {
        // nowhere left to say it
      }
    })
  } catch {
    // no log: say() keeps stderr, which nobody reads; --detach then reports the start as never run
  }
  say(`started in the background (pid ${process.pid}, Node ${process.version})`)
  try {
    return await runServe({ ...opts, logFd: fd })
  } catch (e) {
    say(e?.message ?? String(e))
    return 1
  }
}

/**
 * `centralu serve --stop` (docs/plans/remote-hub.md §10.4, S10): asks the running host to stop over
 * its own socket and waits until it has, so its shutdown runs (its agents, terminals and app
 * processes stopped in order, the store closed). Measured on Windows: killing the WMI-started
 * launcher ended the host 143 ms later with no "shutting down" line, because the host sits in
 * libuv's kill-on-close job object; so on Windows killing is the last resort, not the way.
 *
 * Then, only for a host that did not go: posix SIGTERM to the launcher (which passes it to the host,
 * the same clean stop), and on Windows ending the host. A host from before `host.stop` gets that
 * too. The launcher ends with its host; one still there afterwards is ended.
 *
 * Only the processes serve.pid and host.lock name, and only while they agree with each other and
 * the host answered with this folder's token: a stale pid is never signalled.
 *
 * stdout: one line, `{ v: 1, stop: { ok, wasRunning, how?, message? } }`.
 */
export async function runStop({
  env,
  home,
  entry,
  platform = process.platform,
  timeoutMs = 30_000,
  graceMs = 15_000,
  kill = (pid, sig) => process.kill(pid, sig),
  write = (line) => process.stdout.write(line),
}) {
  const dataDir = serveDataDir(env, home)
  const report = (stop) => answerLine(write, 'stop', stop)
  const state = readServeState(dataDir)
  if (!state) return report({ ok: true, wasRunning: false, message: `no centralu serve has run for ${dataDir}` })
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry) ?? 0
  const prove = hostProvesOf(entry)
  const probe = () => probeHost({ port, token: state.token, protocolVersion: installed, prove })
  const first = await probe()
  if (!heldHere(first, dataDir)) return report({ ok: true, wasRunning: false, message: `centralu serve is not running for ${dataDir}` })

  const hostPid = lockHolderPid(dataDir)
  const launcher = readServePid(dataDir)
  // serve.pid is only believed when it names the host that holds the folder now
  const launcherPid = launcher && hostPid && launcher.hostPid === hostPid ? launcher.pid : null
  const down = async () => !(await probe()).running && !(hostPid && isAlive(hostPid))

  let asked = await askHostToStop({ port, token: state.token, protocolVersion: first.protocolVersion ?? installed, prove })
  if (!asked.ok && asked.protocolVersion !== undefined) asked = await askHostToStop({ port, token: state.token, protocolVersion: asked.protocolVersion, prove })
  let how = 'asked'
  let stopped = asked.ok && (await waitUntil(down, timeoutMs))
  let note = asked.ok ? null : `the host did not take the request to stop (${asked.message})`
  if (!stopped) {
    const target = platform !== 'win32' && launcherPid ? launcherPid : hostPid
    if (target) {
      how = platform === 'win32' ? 'ended' : 'signal'
      try {
        kill(target, 'SIGTERM')
      } catch {
        // gone in the meantime
      }
      stopped = await waitUntil(down, platform === 'win32' ? 5_000 : graceMs)
      if (!stopped && hostPid && isAlive(hostPid)) {
        how = 'ended'
        try {
          kill(hostPid, 'SIGKILL')
        } catch {
          // gone in the meantime
        }
        stopped = await waitUntil(down, 5_000)
      }
    }
    if (how === 'ended') note = `${note ? `${note}; ` : ''}ended the host without its shutdown`
  }
  if (launcherPid && launcherPid !== process.pid && !(await waitUntil(() => !isAlive(launcherPid), 5_000))) {
    try {
      kill(launcherPid, 'SIGKILL')
    } catch {
      // gone in the meantime
    }
  }
  if (!stopped) return report({ ok: false, wasRunning: true, how, message: `the host on 127.0.0.1:${port} is still running${note ? ` (${note})` : ''}` })
  return report({ ok: true, wasRunning: true, how, ...(note ? { message: note } : {}) })
}
