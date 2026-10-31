/**
 * Stopping the host `serve` runs for a data folder, and moving one that runs in a network logon into the person's
 * Windows sign-in (#1224). One module so the foreground `serve` (serve-run.mjs) and `--stop` (serve-detach.mjs) share
 * the stop without importing each other.
 */
import { readServeState, heldHere, startedByServe, foreignHolder, holderWho, lockHolderPid, readServePid, withLivePort } from './serve-files.mjs'
import { DEFAULT_SERVE_PORT } from './serve-port.mjs'
import { protocolVersionOf, probeHost, askHostToStop, askHostRpc } from './serve-host.mjs'
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
 * with this folder's token: a stale pid is never signalled. And only a host `serve` started (`startedByServe`, #1722):
 * a lock held by the app's or the keeper's host is theirs, whatever answers on the port, so `--stop` says whose it is
 * and leaves it.
 *
 * `{ ok, wasRunning, how?, message? }`, the `--stop` line's `stop`. With `ifIdle` (#1224, the hand-over) the host stops only
 * when nothing runs there, and `{ ok: false, busy: true }` says it did not. `forUpdate` (#1618): a hub's update stops it, and
 * the host writes the turns it ends for the next one (`host.stop { forUpdate }`); a host that does not take the request is
 * ended as any is, and lists nothing.
 */
export async function stopServedHost({ dataDir, entry, platform = process.platform, ifIdle = false, forUpdate = false, timeoutMs = 30_000, graceMs = 15_000, kill = (pid, sig) => process.kill(pid, sig) }) {
  const state = withLivePort(dataDir, readServeState(dataDir))
  if (!state) return { ok: true, wasRunning: false, message: `no centralu serve has run for ${dataDir}` }
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry) ?? 0
  // The limited credential is enough to probe and to stop it (#1405, `host.stop` is everyday)
  const own = { token: state.token, proofKey: state.proofKey }
  const probe = () => probeHost({ port, ...own, protocolVersion: installed })
  const first = await probe()
  if (!heldHere(first, dataDir, undefined, state.port != null)) {
    // The folder is held, but not by a serve (#1722): the app's or the keeper's host, whatever answered on the port
    const other = foreignHolder(dataDir)
    const whose = other ? `. It belongs to another Centralu host (pid ${other.pid}), ${holderWho(other.by)}; not stopping it` : ''
    return { ok: true, wasRunning: false, message: `centralu serve is not running for ${dataDir}${whose}` }
  }

  const hostPid = lockHolderPid(dataDir)
  // Only a host `serve` started is ever signalled, whoever answered with this folder's token
  const mayKill = startedByServe(dataDir)
  const launcher = readServePid(dataDir)
  // serve.pid is only believed when it names the host that holds the folder now
  const launcherPid = mayKill && launcher && hostPid && launcher.hostPid === hostPid ? launcher.pid : null
  const down = async () => !(await probe()).running && !(hostPid && isAlive(hostPid))

  let asked = await askHostToStop({ port, ...own, protocolVersion: first.protocolVersion ?? installed, ifIdle, forUpdate })
  if (!asked.ok && asked.protocolVersion !== undefined) asked = await askHostToStop({ port, ...own, protocolVersion: asked.protocolVersion, ifIdle, forUpdate })
  // `ifIdle` and it has work running (#1224): it was left as it is
  if (asked.busy) return { ok: false, wasRunning: true, busy: true, message: asked.message }
  let how = 'asked'
  let stopped = asked.ok && (await waitUntil(down, timeoutMs))
  let note = asked.ok ? null : `the host did not take the request to stop (${asked.message})`
  if (!stopped) {
    const target = platform !== 'win32' && launcherPid ? launcherPid : mayKill ? hostPid : null
    if (hostPid && !mayKill) note = `${note ? `${note}; ` : ''}the lock names pid ${hostPid}, which centralu serve did not start, so it was not signalled`
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

/** How long the hand-over waits for the host's work to end before it gives up and says so (#1224 review) */
export const HANDOVER_WAIT_MS = 30 * 60_000

/**
 * The hand-over (#1224): a `serve` started in the person's Windows sign-in (the scheduled task, at sign-in or from
 * `--detach`) found the folder held by a host that runs in a network logon, the one a hub's ssh started before anyone
 * signed in. Git there cannot use the credentials saved in Windows, so the sign-in's host takes over, but only while that
 * host has nothing running a person would lose. Windows has no keeper, so stopping a host ends what runs in it.
 *
 * The stop is `host.stop {ifIdle}`: the host itself checks and stops in one step, and from its yes on takes no new call,
 * so a turn the hub starts cannot slip in between a check here and the stop (`lifecycle/stop-gate.ts` in agent-host).
 * Until it says yes this asks again every `pollMs`, for `maxWaitMs` at most (30 minutes), and tells the host what it is
 * doing (`host.handover`: `waiting`, then `gave_up`), which a hub linked to it shows on the machine's row. It ends early
 * when that host goes by itself.
 *
 * Resolves true once the folder is free for this serve to start its host, false when there is nothing to move (not
 * Windows, a host in any other logon or too old to say, this serve not in an interactive logon itself) or it gave up.
 * The hub's link loses the machine between the stop and the new host's start, and reconnects by its usual backoff to the
 * same port and token.
 *
 * `existing` is `probeHost`'s answer for the running host. `logonOf`, `stop`, `tell`, `pollMs`, `maxWaitMs` and `now` are
 * parameters for tests.
 */
export async function moveIntoSignIn({
  dataDir,
  entry,
  env,
  existing,
  platform = process.platform,
  logonOf = () => ownLogon(env),
  stop = () => stopServedHost({ dataDir, entry, platform, ifIdle: true }),
  tell = null,
  pollMs = 30_000,
  maxWaitMs = HANDOVER_WAIT_MS,
  now = Date.now,
}) {
  if (platform !== 'win32' || existing?.logon !== 'network') return false
  if ((await logonOf()) !== 'interactive') return false
  const state = withLivePort(dataDir, readServeState(dataDir))
  if (!state) return false
  const port = state.port ?? DEFAULT_SERVE_PORT
  const protocolVersion = existing.protocolVersion ?? protocolVersionOf(entry) ?? 0
  const own = { token: state.token, proofKey: state.proofKey }
  /*
   * `host.handover` takes everyday rights (#1711, docs/plans/key-pairing.md §4.4): said with the credentials this
   * launcher holds for its own host (the limited credential, after a proof under the key), and no credential is made for
   * it. Before, a full one made for this call went to whatever answered that proof, which a reader of serve.json can. A
   * host from #1405 to key pairing refuses it (`link`): no note on the row while this waits, and the move goes on
   */
  const sayHandover = (h) => askHostRpc({ port, ...own, protocolVersion, method: 'host.handover', params: { handover: h } })
  const report = (handover) => (tell ?? sayHandover)(handover)
  const pid = lockHolderPid(dataDir)
  say(`the host running for ${dataDir}${pid ? ` (pid ${pid})` : ''} runs in a network logon (started over ssh), where Git cannot use the credentials saved in Windows; moving it into this Windows sign-in once nothing runs there`)
  const t0 = now()
  let waiting = false
  for (;;) {
    if (!(await probeHost({ port, ...own, protocolVersion })).running) return true
    const r = await stop()
    if (r.ok) {
      say(`stopped it${r.how && r.how !== 'asked' ? ` (${r.how})` : ''}; starting the host in this sign-in`)
      return true
    }
    if (!r.busy) say(`could not stop it: ${r.message ?? 'no reason given'}; asking again later`)
    if (!waiting) {
      say('it has work running (a turn, an approval, a terminal or a command); waiting until it has none')
      await report({ state: 'waiting', since: t0 })
      waiting = true
    }
    if (now() - t0 >= maxWaitMs) {
      await report({ state: 'gave_up', since: now() })
      say(`gave up after ${Math.round(maxWaitMs / 60_000)} minutes: it still had work running. It moves into the sign-in at the next sign-in, or when a linked computer starts it again`)
      return false
    }
    await sleep(pollMs)
  }
}
