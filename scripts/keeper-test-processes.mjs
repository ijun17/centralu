/**
 * Ending everything a keeper integration script started, pass or fail, and saying what went wrong;
 * and talking to a keeper's sockets and waiting on processes, the same way in every script.
 * Shared by `keeper-integration.mjs`, `keeper-children-integration.mjs`,
 * `keeper-handoff-integration.mjs` and `keeper-content-integration.mts`, which run in CI as well as
 * by hand (the `keeper` job in `.github/workflows/build.yml`).
 *
 * Killing the pids a script recorded is not enough. The keeper starts every child in a session of
 * its own (`setsid`), and the processes those children start (a dev server under `sh -c`, a command
 * typed into a terminal, claude's tools) are recorded nowhere. SIGKILL a held shell and what it
 * started is reparented to init, where only its process group still names it. After a handoff the
 * held children's parent, the old keeper, is gone too. So the processes to end are computed from
 * one process table taken before anything is signalled: every descendant of a recorded pid, and
 * every member of a process group a recorded pid leads.
 *
 * Nothing here matches a process by name: the installed Centralu app, its keeper and its host have
 * the same names as what these scripts start (CONTRIBUTING.md, "Never stop what you did not start").
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls `fn` until it gives a truthy value and returns it, or `undefined` once `timeoutMs` has
 * passed. A throw counts as not yet: a socket that is not there yet throws.
 */
export async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(stepMs)
  }
}

/** Whether `pid` names a live process. EPERM means it exists and is someone else's */
export function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * One request, one answer line, on a fresh connection to a keeper socket.
 *
 * 8 s: under CI load a keeper busy starting or swapping a host takes seconds to answer, and the 5 s
 * one script had while the others had 8 s failed its `status` first. The child socket answers a
 * hello with a greeting that carries no `rid`; the request after it (`list`) is what is answered.
 */
export function request(sock, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock)
    let buf = ''
    const timer = setTimeout(() => {
      c.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`))
    c.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      for (const l of lines.slice(0, -1)) {
        const v = JSON.parse(l)
        if (body.op === 'hello' && v.rid === undefined && v.keeperPid) {
          c.write(`${JSON.stringify({ op: 'list', rid: 1 })}\n`)
          continue
        }
        clearTimeout(timer)
        c.end()
        return resolve(v)
      }
      buf = lines.at(-1)
    })
    c.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** The keeper's `status` view */
export const status = (sock) => request(sock, { op: 'status' }).then((r) => r.view)

/** What the keeper holds, from its child socket */
/* The child socket answers only the keeper's hosts (#538): keeper.sock lists what it holds */
export const heldChildren = (data) => request(join(data, 'keeper.sock'), { op: 'children' }).then((r) => r.children ?? [])

/** pid, parent and process group of every process, from one `ps` (the same flags on macOS and Linux) */
function processTable() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length === 3 && cols.every(Number.isInteger))
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))
}

/**
 * The live processes that are `roots` themselves, descend from one, or sit in a process group one
 * of them leads (or led: a group outlives its leader, and its id is not reused while it does).
 * A group is only taken when its leader is in the set, so the script's own group, which every plain
 * `spawn` without `detached` shares, is never taken; the script and its parent are excluded anyway.
 */
export function familyOf(roots) {
  const rows = processTable()
  const leaders = new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 1))
  const family = new Set(rows.filter((r) => leaders.has(r.pid)).map((r) => r.pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) {
      if (family.has(r.pid)) continue
      if (family.has(r.ppid) || leaders.has(r.pgid) || family.has(r.pgid)) {
        family.add(r.pid)
        grew = true
      }
    }
  }
  family.delete(process.pid)
  family.delete(process.ppid)
  return [...family]
}

/** SIGKILLs `roots` and everything `familyOf` finds for them. Returns how many were signalled */
export function killFamily(roots) {
  let n = 0
  for (const pid of familyOf(roots)) {
    try {
      process.kill(pid, 'SIGKILL')
      n++
    } catch {}
  }
  return n
}

/**
 * Runs `cleanup` once, however the script ends: SIGINT (Ctrl-C), SIGTERM and SIGHUP (a cancelled CI
 * job, a closed terminal), or an exception thrown outside the awaited scenario (an event handler).
 * Without this an uncaught error exited before the `finally` that kills what was started.
 */
export function cleanupOnExit(cleanup, log) {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => {
      log(`\n${signal}: stopping everything this script started`)
      cleanup()
      process.exit(code)
    })
  }
  process.on('uncaughtException', (e) => {
    log(`\nerror: ${e?.stack ?? e}`)
    cleanup(true)
    process.exit(1)
  })
}

/**
 * Returns a cleanup that does its work the first time only, whichever exit path calls it. It is
 * called with `true` when the script ended on an error rather than a failed check.
 */
export function once(fn) {
  let done = false
  return (threw = false) => {
    if (done) return
    done = true
    fn(threw)
  }
}

/**
 * The end of the keeper's and the host's logs in each data folder, for a failed run: a check's name
 * says what fell over, the logs say why (a host's crash is only in `host.log`), and the folders are
 * removed right after. Ephemeral test tokens may appear; they die with the run.
 */
export function printLogTails(dirs, log, lines = 40) {
  for (const dir of dirs) {
    for (const name of ['keeper.log', 'host.log']) {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      const tail = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines)
      log(`\n--- last ${tail.length} lines of ${file}`)
      for (const l of tail) log(`  | ${l}`)
    }
  }
}
