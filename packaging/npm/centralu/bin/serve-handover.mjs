/**
 * Stopping the host `serve` runs for a data folder, and moving one that runs in a network logon into the person's
 * Windows sign-in (#1224). One module so the foreground `serve` (serve-run.mjs) and `--stop` (serve-detach.mjs) share
 * the stop without importing each other.
 */
import { readServeState, heldHere, lockHolderPid, readServePid } from './serve-files.mjs'
import { DEFAULT_SERVE_PORT } from './serve-port.mjs'
import { protocolVersionOf, hostProvesOf, probeHost, askHostToStop, askHostActivity } from './serve-host.mjs'
import { ownLogon } from './serve-windows.mjs'
import { isAlive, say, sleep, waitUntil } from './serve-util.mjs'

/**
 * Asks the host serve runs for `dataDir` to stop over its own socket and waits until it has, so its shutdown runs (its
 * agents, terminals and app processes stopped in order, the store closed). Measured on Windows: killing the
 * WMI-started launcher ended the host 143 ms later with no "shutting down" line, because the host sits in libuv's
 * kill-on-close job object; so on Windows killing is the last resort, not the way.
 *
 * Then, only for a host that did not go: posix SIGTERM to the launcher (which passes it to the host, the same clean
 * stop), and on Windows ending the host. A host from before `host.stop` gets that too. The launcher ends with its host;
 * one still there afterwards is ended.
 *
 * Only the processes serve.pid and host.lock name, and only while they agree with each other and the host answered
 * with this folder's token: a stale pid is never signalled.
 *
 * `{ ok, wasRunning, how?, message? }`, the `--stop` line's `stop`.
 */
export async function stopServedHost({ dataDir, entry, platform = process.platform, timeoutMs = 30_000, graceMs = 15_000, kill = (pid, sig) => process.kill(pid, sig) }) {
  const state = readServeState(dataDir)
  if (!state) return { ok: true, wasRunning: false, message: `no centralu serve has run for ${dataDir}` }
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry) ?? 0
  const prove = hostProvesOf(entry)
  const probe = () => probeHost({ port, token: state.token, protocolVersion: installed, prove })
  const first = await probe()
  if (!heldHere(first, dataDir)) return { ok: true, wasRunning: false, message: `centralu serve is not running for ${dataDir}` }

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
  if (!stopped) return { ok: false, wasRunning: true, how, message: `the host on 127.0.0.1:${port} is still running${note ? ` (${note})` : ''}` }
  return { ok: true, wasRunning: true, how, ...(note ? { message: note } : {}) }
}

/** Whether `host.activity`'s counts say nothing would be lost: no turn, approval, question, background work, terminal or command */
export function nothingRunning(a) {
  if (!a || typeof a !== 'object') return false
  return ['working', 'approvals', 'questions', 'background', 'terminals', 'commandRuns'].every((k) => (Number(a[k]) || 0) === 0)
}

/**
 * The hand-over (#1224): a `serve` started in the person's Windows sign-in (the scheduled task, at sign-in or from
 * `--detach`) found the folder held by a host that runs in a network logon, the one a hub's ssh started before anyone
 * signed in. Git there cannot use the credentials saved in Windows, so the sign-in's host takes over, but only once that
 * host has nothing running a person would lose (`nothingRunning`, the host's own idle rule: a turn, an approval or a
 * question waiting, background work, an open terminal or a running command). Windows has no keeper, so stopping a host
 * ends what runs in it. Until then this waits, asking every `pollMs`; it ends early when that host goes by itself.
 *
 * Resolves true once the folder is free for this serve to start its host, false when there is nothing to move: not
 * Windows, a host in any other logon (or one too old to say), or this serve not in an interactive logon itself. The hub's
 * link loses the machine between the stop and the new host's start, and reconnects by its usual backoff to the same
 * port and token.
 *
 * `existing` is `probeHost`'s answer for the running host. `logonOf`, `stop`, `activity` and `pollMs` are parameters for tests.
 */
export async function moveIntoSignIn({
  dataDir,
  entry,
  env,
  existing,
  platform = process.platform,
  logonOf = () => ownLogon(env),
  stop = () => stopServedHost({ dataDir, entry, platform }),
  activity = null,
  pollMs = 30_000,
}) {
  if (platform !== 'win32' || existing?.logon !== 'network') return false
  if ((await logonOf()) !== 'interactive') return false
  const state = readServeState(dataDir)
  if (!state) return false
  const port = state.port ?? DEFAULT_SERVE_PORT
  const prove = hostProvesOf(entry)
  const protocolVersion = existing.protocolVersion ?? protocolVersionOf(entry) ?? 0
  const ask = activity ?? (() => askHostActivity({ port, token: state.token, protocolVersion, prove }))
  const pid = lockHolderPid(dataDir)
  say(`the host running for ${dataDir}${pid ? ` (pid ${pid})` : ''} runs in a network logon (started over ssh), where Git cannot use the credentials saved in Windows; moving it into this Windows sign-in once nothing runs there`)
  let waited = false
  for (;;) {
    if (!(await probeHost({ port, token: state.token, protocolVersion, prove })).running) return true
    if (nothingRunning(await ask())) {
      const r = await stop()
      if (r.ok) {
        say(`stopped it${r.how && r.how !== 'asked' ? ` (${r.how})` : ''}; starting the host in this sign-in`)
        return true
      }
      say(`could not stop it: ${r.message ?? 'no reason given'}; asking again later`)
    } else if (!waited) {
      say('it has work running (a turn, an approval, a terminal or a command); waiting until it has none')
      waited = true
    }
    await sleep(pollMs)
  }
}
