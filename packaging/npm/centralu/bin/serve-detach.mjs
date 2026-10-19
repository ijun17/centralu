/**
 * `centralu serve --detach` and `--stop`: starting serve outside the ssh session that asked, and
 * stopping it in order (docs/plans/remote-hub.md §10.4).
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { answerLine, isAlive, renameRetrying, say, sayTo, runCaptured, tail, sleep } from './serve-util.mjs'
import { SERVE_LOG_FILE, serveDataDir, ensureServeState } from './serve-files.mjs'
import { askPowershell, detachHow, windowsArg, wmiScript, parseWmiAnswer, wmiBlockedMessage, windowsPowershell, windowsTool, wslDistro, wslUser } from './serve-windows.mjs'
import { CHILD_FLAG } from './serve-args.mjs'
import { startInSignIn } from './serve-autostart.mjs'
import { stopServedHost } from './serve-handover.mjs'
import { connectionLine, serveFrom } from './serve-host.mjs'
import { describe, runServe, serveFolder } from './serve-run.mjs'

/**
 * What a detached launcher needs from the `--detach` that started it. A process created through WMI
 * does not inherit this environment: it gets the account's default one. Everything else it needs
 * (the token, the port) is in the data folder. Never a secret.
 */
export const CARRIED_ENV = ['CC_DATA_DIR', 'CENTRALU_HOST_ENTRY', 'CENTRALU_MANAGED', 'CENTRALU_STARTED_FROM']

/**
 * `start` is how the launcher was started and why (`through WMI: <reason>`), which it writes into its first serve.log
 * line, so a host that ended up outside the Windows sign-in says why (#1223)
 */
export function encodeChildSpec({ env, log, start = null }) {
  const carried = {}
  for (const k of CARRIED_ENV) if (typeof env[k] === 'string' && env[k]) carried[k] = env[k]
  return Buffer.from(JSON.stringify({ log, env: carried, ...(start ? { start } : {}) }), 'utf8').toString('base64url')
}

/** `{ log, env, start? }` from `--detached-child=`, only the carried variables; null when it is not one */
export function decodeChildSpec(raw) {
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (typeof v?.log !== 'string' || !v.log) return null
    const env = {}
    for (const k of CARRIED_ENV) if (typeof v.env?.[k] === 'string') env[k] = v.env[k]
    return { log: v.log, env, ...(typeof v.start === 'string' && v.start ? { start: v.start } : {}) }
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
  from = null,
  platform = process.platform,
  execPath = process.execPath,
  cwd = process.cwd(),
  start = startDetached,
  how = detachHow(platform, env),
  signIn = startInSignIn,
  signInMs = 20_000,
  timeoutMs = 30_000,
  noStartMs = 10_000,
  write = (line) => process.stdout.write(line),
}) {
  // Created here, so the token exists before the launcher reads it and `answered` reads it again
  const { dataDir } = serveFolder({ env, home, cliPath, platform })
  const fail = (reason, message) => answerLine(write, 'detach', { ok: false, how, reason, message })
  const answered = async (already, as = how) => {
    const d = await describe({ env, dataDir, state: ensureServeState(dataDir, platform), entry, version })
    if (!d?.hostRunning) return false
    write(`${connectionLine({ ...d, detach: { ok: true, how: as, already } })}\n`)
    return true
  }
  if (await answered(true)) return 0

  const log = join(dataDir, SERVE_LOG_FILE)
  /*
   * One start per log: the last one's is kept beside it, and its absence is how a start that never ran shows. So a log
   * that cannot be moved aside (a reader holds `serve.log.1`) is removed rather than left to read as a start
   */
  const freshLog = () => {
    try {
      renameRetrying(log, `${log}.1`)
    } catch (e) {
      if (e?.code !== 'ENOENT') rmSync(log, { force: true, maxRetries: 5 })
    }
  }

  /*
   * Windows: in the person's sign-in when someone is signed in (#1224), through the scheduled task, and through WMI only
   * when nobody is. WMI's process keeps this ssh session's network logon, where Git cannot use the credentials saved in
   * Windows. A task-started host that does not answer in time is left to the lock: the WMI start below then either
   * holds the folder or is refused by it, never a second host on it. Which way it went, and why, is one line of
   * serve.log (#1223): the task's serve writes no serve.log, so that line is written here; a WMI launcher writes its own
   */
  let notInSignIn = null
  if (how === 'wmi') {
    const s = await signIn({ dataDir, env, home, platform })
    if (s.started) {
      const line = `started centralu serve in the Windows sign-in (the scheduled task "${s.name}"); waiting for its host`
      say(line)
      freshLog()
      try {
        writeFileSync(log, `[centralu serve] ${line}\n`)
      } catch {
        // the line on stderr is all there is
      }
      const t0 = Date.now()
      while (Date.now() - t0 < signInMs) {
        if (await answered(false, 'task')) return 0
        await sleep(250)
      }
      notInSignIn = `the host the sign-in task "${s.name}" started did not answer within ${Math.round(signInMs / 1000)} s`
      // The WMI launcher's first line says so; the task's line goes, so `serve.log.1` keeps the start before this one
      rmSync(log, { force: true, maxRetries: 5 })
    } else {
      notInSignIn = signInMissed(s)
    }
    say(`${notInSignIn}: starting the host through WMI${s.reason === 'nosession' ? ', outside any sign-in, where Git cannot use the credentials saved in Windows' : ''}`)
  }

  freshLog()
  // Where this was asked for from (#1223): the launcher runs outside this ssh session, so it is told
  const asked = serveFrom(env, from)
  const childEnv = asked ? { ...env, CENTRALU_STARTED_FROM: JSON.stringify(asked) } : env
  const startedHow = `through ${how === 'wmi' ? 'WMI' : how === 'wsl' ? 'a WMI-created wsl.exe' : how}${notInSignIn ? `: ${notInSignIn}` : ''}`
  const args = [cliPath, 'serve', ...(port !== null ? ['--port', String(port)] : []), `${CHILD_FLAG}${encodeChildSpec({ env: childEnv, log, start: startedHow })}`]
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

/** Why the host was not started in the Windows sign-in, from `startInSignIn`'s answer, for serve.log and stderr */
export function signInMissed(s) {
  if (s.reason === 'nosession') {
    const n = s.desktops
    const unread = s.unreadable ? `, ${s.unreadable} of them with an owner WMI would not tell` : ''
    const seen =
      typeof n !== 'number'
        ? 'no Explorer of this account in a desktop session'
        : n === 0
          ? 'no Explorer in any desktop session'
          : `none of the ${n} Explorer${n === 1 ? '' : 's'} in desktop sessions is this account's${unread}`
    return `no Windows sign-in of this user was found (${seen})`
  }
  // It travels on the launcher's command line: bounded
  if (s.reason === 'error') return `the sign-in task failed: ${String(s.message).slice(0, 300)}`
  if (s.reason === 'off') return 'the sign-in task is turned off (CENTRALU_SIGNIN_TASK=off)'
  if (s.reason === 'no_launcher') return 'there is no launcher in the data folder for the sign-in task to run'
  return `the sign-in task was not used (${s.reason})`
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
  // One line saying how it was started and why (#1223), and what runs
  say(`started in the background${spec.start ? ` ${spec.start}` : ''} (pid ${process.pid}, Node ${process.version})`)
  try {
    return await runServe({ ...opts, logFd: fd })
  } catch (e) {
    say(e?.message ?? String(e))
    return 1
  }
}

/**
 * `centralu serve --stop` (docs/plans/remote-hub.md §10.4, S10): the running host stopped in order, over its own
 * socket, and waited for (`stopServedHost` in serve-handover.mjs, which the hand-over into the sign-in shares, #1224).
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
  return answerLine(write, 'stop', await stopServedHost({ dataDir, entry, platform, timeoutMs, graceMs, kill }))
}
