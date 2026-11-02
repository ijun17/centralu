/**
 * The headless keeper `centralu serve` starts on Linux in the host's place (docs/plans/remote-keeper.md §8, step 3), and
 * talking to a running one over its control socket (`<data>/keeper.sock`, one JSON line each way).
 *
 * `serve` starts it with the port, the Node and the host folder, and the key on its stdin, as it starts a host without a
 * keeper, and stays its parent. The keeper starts the host and holds its agents, terminals and commands.
 */
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { isAlive } from './serve-util.mjs'

/** The keeper's file name, beside `host/` in the host-only package (`@centralu/host-linux-<arch>`, remote-keeper.md §7) */
export const KEEPER_FILE = 'centralu-keeper'

/**
 * The keeper `serve` starts for the host at `entry`, or null: on Linux, when `centralu-keeper` sits beside the host's
 * folder and `CENTRALU_KEEPER` is not `off`. A host run from source (a `.ts` entry) has none, and `off` is how one machine
 * goes back to a host without a keeper (remote-keeper.md §9).
 */
export function keeperExe(entry, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'linux' || env.CENTRALU_KEEPER === 'off' || !entry.endsWith('.mjs')) return null
  const exe = join(dirname(dirname(entry)), KEEPER_FILE)
  return exists(exe) ? exe : null
}

/**
 * What to run: the keeper when there is one (`keeperExe`), else the host (`hostCommand`). The keeper's group is its own,
 * like the host's, so the terminal's Ctrl+C reaches only this launcher, which passes one signal on.
 */
export function keeperCommand(exe, entry, { port, dataDir, version, execPath }) {
  return {
    command: exe,
    args: ['--headless', '--data-dir', dataDir, '--port', String(port), '--node', execPath, '--host-source', dirname(entry), '--app-version', version],
    detached: true,
  }
}

/**
 * One request to the keeper's control socket and its one-line answer, or null when there is no keeper there, it does not
 * answer in `timeoutMs`, or the answer is not JSON.
 */
export function askKeeper(dataDir, request, { timeoutMs = 5000, connectTo = connect } = {}) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const socket = connectTo(join(dataDir, 'keeper.sock'))
    const end = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => end(null), timeoutMs)
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        end(JSON.parse(buf.slice(0, nl)))
      } catch {
        end(null)
      }
    })
    socket.once('error', () => end(null))
    socket.once('close', () => end(null))
  })
}

/**
 * The pid of the keeper this folder's `serve` started, or null: serve.pid names it (`keeperPid`) and keeper.lock, which the
 * keeper writes its own pid into and holds, agrees and is alive. Neither alone is believed: a stale file never makes a
 * pid one to talk to or signal.
 */
export function keeperPidOf(dataDir, served) {
  const pid = served?.keeperPid
  if (!Number.isInteger(pid) || !isAlive(pid)) return null
  try {
    return Number(readFileSync(join(dataDir, 'keeper.lock'), 'utf8').trim()) === pid ? pid : null
  } catch {
    return null
  }
}

/**
 * `{ pid, build }` for the connection line's `keeper` (additive): the running keeper's pid and the version of the build it
 * was started from, or null when none runs. A keeper that is alive but does not answer is still reported, by pid alone.
 */
export async function keeperInfo(dataDir, served, ask = askKeeper) {
  const pid = keeperPidOf(dataDir, served)
  if (pid === null) return null
  const answer = await ask(dataDir, { op: 'status' }, { timeoutMs: 2000 })
  const build = answer?.view?.keeper?.version
  return { pid, ...(typeof build === 'string' ? { build } : {}) }
}

/**
 * `stop` on the keeper, as `askHostToStop` makes it on a host: `{ ok: true }` once it took it, `{ ok: false, busy: true,
 * message, activity, calls }` when `ifIdle` and something runs (nothing was changed), `{ ok: false, message }` otherwise.
 * `forUpdate` (#1618): a hub's update stops it, and the host lists the turns it ends for the next one.
 */
export async function askKeeperToStop(dataDir, { ifIdle = false, forUpdate = false, timeoutMs = 30_000, ask = askKeeper } = {}) {
  const a = await ask(dataDir, { op: 'stop', ...(ifIdle ? { ifIdle: true } : {}), ...(forUpdate ? { forUpdate: true } : {}) }, { timeoutMs })
  if (a === null) return { ok: false, message: 'the keeper did not answer' }
  if (a.ok === true) return { ok: true }
  if (a.busy === true) return { ok: false, busy: true, message: 'it has work running', activity: a.activity ?? null, calls: a.calls ?? 0 }
  return { ok: false, message: typeof a.error === 'string' ? a.error : 'refused' }
}
