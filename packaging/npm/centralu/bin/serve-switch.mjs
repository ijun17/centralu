/**
 * `centralu serve --switch`: the machine runs a version switch of the install the hub manages (docs/plans/remote-hub.md
 * §10.5a, #1903). The hub places the new version beside the running one, then hands this one command over ssh, and from
 * then on only reads the outcome (`--switch-status`). Whatever happens to the hub or the link after the handover, the
 * switcher, detached here the way `--detach` detaches a host, stops the old host, switches the pointers, starts and
 * checks the new version, and puts the old one back when it does not answer.
 *
 * The switcher is the launcher of the newer of the two versions. It drives the other one only through the CLI every
 * managed version has (`serve --stop`, `serve --detach`, `serve --connection`), run on its own Node from its folder under
 * `<data>/remote/versions/`, as the managed launcher runs it: nothing is imported across versions.
 *
 * What it does is in `<data>/remote/switch.json`, each step written before it is taken, and `switch.lock` names the live
 * process at work. A switcher that died is finished by the next reader (`reconcile`): `--switch-status`, any `serve` or
 * `--detach` there, or the next `--switch`.
 */
import { spawn } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { answerLine, replaceFile, runCaptured, say, sleep, tail, waitUntil } from './serve-util.mjs'
import { isWriter, isWriterWithin, processStartTime, serveDataDir } from './serve-files.mjs'
import { POINTER_WORD, managedLauncherScript, parsePointer, remoteLayout } from './serve-install.mjs'
import { detachHow } from './serve-windows.mjs'

export const SWITCH_FILE = 'switch.json'
export const SWITCH_LOCK = 'switch.lock'
/**
 * The version whose launcher ran the last switch, as a pointer line, written by the hub's handover command before it runs
 * it: the one that reads its status (`--switch-status`), whatever `current` is by then, and that a prune keeps
 */
export const SWITCH_RUNNER = 'switch.runner'

/** How long the started version has to say hello as itself (plan §10.5 step 4) */
const CHECK_MS = 30_000
const NO_ANSWER = `it did not answer within ${CHECK_MS / 1000} s`
/** How long the handover waits for the detached switcher to write its pid before it runs the switch itself */
const HANDOVER_MS = 10_000
/**
 * A live pid whose creation time Windows cannot read (another logon's process) counts as the switcher while its record
 * is younger than this: past the longest switch (a stop of 30 s, a start and check of 60 s, a put-back of 60 s), so a
 * pid reused later is not believed for long
 */
const UNREADABLE_ALIVE_MS = 10 * 60_000
/** The steps between a stop and the start that follows it: no other host may start then */
const QUIET_STEPS = new Set(['stop', 'backup', 'switch', 'restore_store', 'roll_back'])

const LOCAL_BUILD = /\.local\.\d+$/
const pointer = (v) => (v && POINTER_WORD.test(String(v.version)) && POINTER_WORD.test(String(v.node)) ? { version: v.version, node: v.node } : null)
const line = (p) => `${p.version} ${p.node}\n`

/**
 * The switch the hub asked for, from `--switch`'s argument (base64url of the hub's JSON, update.ts `switchCommand`),
 * which `--switch-run` is handed unchanged; null when it is not one
 */
export function decodeSwitch(raw) {
  try {
    const p = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    const to = pointer(p?.to)
    if (!to || typeof p.id !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(p.id)) return null
    const by = typeof p.by === 'string' ? p.by.replace(/[^\w .()@-]/g, '').slice(0, 80) : 'another computer'
    const was = { current: pointer(p.was?.current), previous: pointer(p.was?.previous) }
    return { id: p.id, by, to, keep: pointer(p.keep), was, saveStore: p.saveStore === true }
  } catch {
    return null
  }
}

/** `--switch-run`'s second argument: the data folder, which a process WMI creates does not inherit (base64url) */
const dataDirArg = (env) => (env.CC_DATA_DIR ? [Buffer.from(env.CC_DATA_DIR, 'utf8').toString('base64url')] : [])
const withDataDir = (env, arg) => (arg ? { ...env, CC_DATA_DIR: Buffer.from(arg, 'base64url').toString('utf8') } : env)

/** A time as `--detach`, `serve` and the hub's refusal say it: HH:MM, local */
export const clockOf = (at) => (typeof at === 'number' ? new Date(at).toTimeString().slice(0, 5) : 'an unknown time')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** `switch.json`, or null when there is none */
export function readSwitch(dataDir) {
  const s = readJson(join(remoteLayout(dataDir).root, SWITCH_FILE))
  return s && typeof s.id === 'string' ? s : null
}

function readPointerFile(file) {
  try {
    return parsePointer(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Whether `switch.lock` names a live switcher (`isWriter`), a Windows pid of another logon counting for a while */
export function lockIsLive(holder, writer = isWriter) {
  if (!holder || !Number.isInteger(holder.pid)) return false
  return isWriterWithin(holder, UNREADABLE_ALIVE_MS, writer)
}

/**
 * Takes `switch.lock` for `id`: an exclusive create naming this process, so of two switchers only one runs. A lock whose
 * process is not alive is stale and is taken over, moved aside first so of two takers only one removes it. Null when a
 * live process holds it. The function it returns releases it, only while it is still this one's
 */
function takeLock(root, id) {
  const file = join(root, SWITCH_LOCK)
  const own = { id, pid: process.pid, started: processStartTime(process.pid), at: Date.now() }
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeSync(fd, JSON.stringify(own))
      } finally {
        closeSync(fd)
      }
      return () => {
        const now = readJson(file)
        if (now?.pid === own.pid && now.at === own.at) rmSync(file, { force: true })
      }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
    const holder = readJson(file)
    if (holder ? lockIsLive(holder) : youngerThan(file, 5_000)) return null
    const aside = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.stale`
    try {
      renameSync(file, aside)
      rmSync(aside, { force: true })
    } catch {
      // moved by another taker first
    }
  }
  return null
}

function youngerThan(file, ms) {
  try {
    return Date.now() - statSync(file).mtimeMs < ms
  } catch {
    return false
  }
}

/** One managed version's Node and `centralu.mjs`, as the managed launcher finds them */
function versionPaths(l, v, platform) {
  return {
    node: platform === 'win32' ? join(l.node, `v${v.node}`, 'node.exe') : join(l.node, `v${v.node}`, 'bin', 'node'),
    cli: join(l.versions, v.version, 'node_modules', 'centralu', 'bin', 'centralu.mjs'),
  }
}

/** One version's `centralu serve <args>`, on its own Node, as the managed launcher runs it */
function serveOf(l, v, args, env, platform) {
  const { node, cli } = versionPaths(l, v, platform)
  return runCaptured(node, [cli, 'serve', ...args], { ...env, CENTRALU_MANAGED: '1' })
}

/** The last `{ v: 1, … }` line of `stdout` that `pick` finds something in */
function lastLine(stdout, pick) {
  for (const l of String(stdout).split(/\r?\n/).reverse()) {
    if (!l.trim().startsWith('{')) continue
    try {
      const o = JSON.parse(l)
      if (o?.v === 1 && pick(o) !== undefined) return pick(o)
    } catch {
      // not a line of serve's
    }
  }
  return undefined
}

/** The end of `host.log`, in one line for a sentence ("" when there is none) */
export function hostLogTail(dataDir) {
  const text = tail(join(dataDir, 'host.log'), 12)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' / ')
  return text.length > 600 ? `…${text.slice(-600)}` : text
}

/**
 * Writes both pointers (`previous` first, then `current`, each by rename) and the managed launcher when it is not there
 * yet (an update over an npm install). A null `current` gives the machine back the Centralu it ran before: the pointers
 * and the launcher go, so the lookup finds that one again
 */
export function setPointers(dataDir, current, previous, platform = process.platform) {
  const l = remoteLayout(dataDir)
  const launcher = join(l.bin, platform === 'win32' ? 'centralu.cmd' : 'centralu')
  if (!current) {
    for (const f of [l.previous, l.current, launcher]) rmSync(f, { force: true })
    return
  }
  for (const v of [current, previous].filter(Boolean)) {
    if (!existsSync(join(l.versions, v.version, 'install.json')) || !existsSync(join(l.node, `v${v.node}`))) throw new Error(`Centralu ${v.version} on Node ${v.node} is not there`)
  }
  if (!existsSync(launcher)) {
    mkdirSync(l.bin, { recursive: true })
    replaceFile(launcher, managedLauncherScript(platform), { mode: 0o755 })
  }
  if (previous) replaceFile(l.previous, line(previous))
  else rmSync(l.previous, { force: true })
  replaceFile(l.current, line(current))
}

/**
 * Removes every version that is neither `current` nor `previous` nor the switch's runner (which reads its outcome), every
 * Node none of them uses, and the store copies of versions that are gone (plan §10.5 step 6). A folder that cannot go (a Windows program still running from it) stays
 * and is named, never fatal
 */
export function prune(dataDir) {
  const l = remoteLayout(dataDir)
  const keep = [readPointerFile(l.current), readPointerFile(l.previous), readPointerFile(join(l.root, SWITCH_RUNNER))].filter(Boolean)
  const removed = []
  const left = []
  const sweep = (dir, kept, named = true) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (kept(name) || (name.startsWith('.') && !name.startsWith('.replaced-'))) continue
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
        if (named && !name.startsWith('.')) removed.push(name)
      } catch {
        if (named) left.push(name)
      }
    }
  }
  sweep(l.versions, (n) => keep.some((p) => p.version === n))
  // What the installer moved aside and could not remove then
  sweep(l.root, (n) => !n.startsWith('.replaced-'))
  sweep(l.node, (n) => keep.some((p) => `v${p.node}` === n))
  sweep(join(l.root, 'store-backup'), (n) => keep.some((p) => p.version === n), false)
  return { removed, left }
}

/** The files of the host's store in the data folder: the database and SQLite's write-ahead log beside it */
const STORE_FILES = ['store.db', 'store.db-wal', 'store.db-shm']

/**
 * A copy of the store taken while no host runs, before a dev build first opens it (#1036): a dev build may migrate the
 * store past what the version before it reads, which would then refuse to start. Kept per `owner`, the version that left
 * the store so (`store-backup/<owner>/`), replaced whole
 */
export function storeBackup(dataDir, owner, before) {
  const dir = join(remoteLayout(dataDir).root, 'store-backup')
  const partial = join(dir, `.partial-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  rmSync(partial, { recursive: true, force: true })
  try {
    mkdirSync(partial, { recursive: true })
    const files = STORE_FILES.filter((f) => existsSync(join(dataDir, f)))
    for (const f of files) cpSync(join(dataDir, f), join(partial, f))
    writeFileSync(join(partial, 'backup.json'), JSON.stringify({ owner, before, files, at: new Date().toISOString() }, null, 2) + '\n')
    rmSync(join(dir, owner), { recursive: true, force: true })
    renameSync(partial, join(dir, owner))
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
}

/**
 * Puts back the copy `storeBackup` took for `owner`, no host running; false when there is none. A write-ahead log the
 * copy did not have is removed, so SQLite does not replay the dev build's changes onto it. The copy stays
 */
export function storeRestore(dataDir, owner) {
  const dir = join(remoteLayout(dataDir).root, 'store-backup', owner)
  const meta = readJson(join(dir, 'backup.json'))
  if (meta?.owner !== owner || !Array.isArray(meta.files)) return false
  for (const f of STORE_FILES) rmSync(join(dataDir, f), { force: true })
  for (const f of meta.files.filter((f) => STORE_FILES.includes(f))) cpSync(join(dir, f), join(dataDir, f))
  return true
}

/**
 * The work of one switch, in a data folder, with the steps written to `switch.json` as they are taken. `state` is the
 * file's content; `finish` writes the outcome
 */
function switchWork(dataDir, state, { env, platform }) {
  const l = remoteLayout(dataDir)
  const file = join(l.root, SWITCH_FILE)
  /** Answers the switch as written, which `runSwitcher` and `reconcile` answer in turn (a status read prints it) */
  const write = (patch) => {
    Object.assign(state, patch, { at: Date.now() })
    replaceFile(file, `${JSON.stringify(state)}\n`)
    return state
  }
  const step = (s) => write({ step: s })
  const from = state.was.current
  const to = state.to

  /** `serve --stop` of `v` (for an update: the stopping host lists the turns it ends, #1618) */
  const stopWith = async (v) => {
    const r = await serveOf(l, v, ['--stop'], { ...env, CENTRALU_STOP_BY: 'hub', CENTRALU_STOP_FOR: 'update' }, platform)
    const stop = lastLine(r.stdout, (o) => o.stop)
    if (!stop) return { ok: false, wasRunning: false, message: r.stderr.trim().split(/\r?\n/).at(-1) || `serve --stop gave no answer (exit ${r.code})` }
    return { ok: stop.ok === true, wasRunning: stop.wasRunning === true, message: typeof stop.message === 'string' ? stop.message : null }
  }

  /**
   * What answers within `ms`, by the connection line of the version `asker`: `{ ok: true }` once a host answers as
   * `version` (null: any), `{ ok: false, other }` at once when one answers as another version, `{ ok: false }` when none
   * did. Asked at least once
   */
  const hear = async (asker, version, ms = CHECK_MS) => {
    const until = Date.now() + ms
    for (;;) {
      const r = await serveOf(l, asker, ['--connection'], env, platform)
      const said = lastLine(r.stdout, (o) => (typeof o.port === 'number' ? o : undefined))
      if (said?.hostRunning === true && (version === null || said.version === version)) return { ok: true }
      if (said?.hostRunning === true && typeof said.version === 'string') return { ok: false, other: said.version }
      if (Date.now() >= until) return { ok: false }
      await sleep(1_000)
    }
  }

  /**
   * `v` started and answering as itself; otherwise why not. A start refused for WMI is left to the hub's link
   * (`unchecked`). A host of another version found there instead was started meanwhile by something that does not ask
   * the switch (a version from before it, through the sign-in task, the person or another hub): it is stopped and `v`
   * started again, twice at most (#1907)
   */
  const startAndCheck = async (v, [startStep, checkStep] = ['start', 'check']) => {
    for (let stopped = 0; ; stopped++) {
      step(startStep)
      const r = await serveOf(l, v, ['--detach'], env, platform)
      const detach = lastLine(r.stdout, (o) => o.detach)
      if (detach?.ok === false && detach.reason === 'wmi_blocked') return { why: null, unchecked: detach.message ?? 'WMI is blocked' }
      const failed = detach?.ok === false ? (detach.message ?? 'it did not start') : !detach ? r.stderr.trim().split(/\r?\n/).at(-1) || `serve --detach gave no answer (exit ${r.code})` : null
      if (checkStep) step(checkStep)
      // A start that failed may have met a host starting meanwhile: a few seconds tell
      const heard = await hear(v, v.version, failed ? 5_000 : CHECK_MS)
      if (heard.ok) return { why: null }
      if (!heard.other) return { why: failed ?? NO_ANSWER }
      if (stopped === 2) return { why: `Centralu ${heard.other} answered there instead; something started it again during the switch` }
      write({ startedMeanwhile: heard.other })
      await stopWith(from && heard.other === from.version ? from : v)
    }
  }

  /** The old version back after `why`: the new host stopped, the pointers as they were, the old host started and heard */
  const putBack = async (why, extra = {}) => {
    // `why` is kept from here, so a reader that finishes this put-back can still say it
    write({ step: 'roll_back', why })
    const log = hostLogTail(dataDir)
    const stop = await stopWith(readPointerFile(l.current) ?? to)
    const stopFailed = stop.ok ? null : stop.message
    try {
      setPointers(dataDir, from, state.was.previous, platform)
      if (state.saveStore && from) storeRestore(dataDir, from.version)
      if (state.wasRunning !== false) {
        if (from) {
          const back = await startAndCheck(from, ['restart', null])
          if (back.why) throw new Error(back.why === NO_ANSWER ? `${NO_ANSWER} either` : back.why)
        } else {
          await startNpm(dataDir, env, platform)
          if (!(await hear(to, null)).ok) throw new Error(`${NO_ANSWER} either`)
        }
      }
    } catch (err) {
      return write({ outcome: 'failed', stage: 'put_back', why, putBackWhy: err.message, stopFailed, log, ...extra })
    }
    return write({ outcome: 'put_back', why, log, ...extra })
  }

  return { step, write, stopWith, hear, startAndCheck, putBack, from, to }
}

/** The Centralu an npm install keeps its launcher for (`<data>/bin/centralu`), started again after a failed first switch */
function startNpm(dataDir, env, platform) {
  const win = platform === 'win32'
  const launcher = join(dataDir, 'bin', win ? 'centralu.cmd' : 'centralu')
  if (!existsSync(launcher)) throw new Error('the Centralu that ran before has no launcher in the data folder')
  return new Promise((resolve, reject) => {
    const child = spawn(win ? `"${launcher}"` : launcher, ['serve', '--detach'], { env, stdio: 'ignore', shell: win, windowsHide: true })
    child.once('error', reject)
    child.once('close', () => resolve())
  })
}

/**
 * The switch itself (plan §10.5 steps 2 to 6): stop the running host, switch the pointers, start and check the new
 * version, then prune; or put the old version back. `onLocked` runs once the lock is this one's. Returns the outcome
 * written, or null when a live switcher holds the lock
 */
export async function runSwitcher({ dataDir, params, env, platform = process.platform, onLocked = () => {} }) {
  const l = remoteLayout(dataDir)
  mkdirSync(l.root, { recursive: true })
  const release = takeLock(l.root, params.id)
  if (!release) return null
  try {
    const state = { v: 1, ...params, from: params.was.current, step: 'stop', startedAt: Date.now(), pid: process.pid, started: processStartTime(process.pid) }
    const w = switchWork(dataDir, state, { env, platform })
    w.write({})
    onLocked(state)
    const { from, to } = w
    const stop = await w.stopWith(from ?? to)
    if (!stop.ok) return w.write({ outcome: 'failed', stage: 'stop', why: stop.message ?? 'no reason given' })
    w.write({ wasRunning: stop.wasRunning })
    if (params.saveStore && from) {
      w.step('backup')
      try {
        storeBackup(dataDir, from.version, to.version)
      } catch (err) {
        // Nothing was switched: the old version starts again as it was
        if (stop.wasRunning) await w.startAndCheck(from, ['restart', null])
        return w.write({ outcome: 'failed', stage: 'backup', why: err.message })
      }
    }
    w.step('switch')
    try {
      setPointers(dataDir, to, params.keep, platform)
    } catch (err) {
      // `await`: the lock is released in `finally` only once the put-back is done
      return await w.putBack(err.message)
    }
    let started = await w.startAndCheck(to)
    let restored = false
    // Leaving a dev build for a release that refuses the store the dev build left: the copy taken for it, and one more start (#1036)
    if (started.why && !params.saveStore && LOCAL_BUILD.test(from?.version ?? '') && !LOCAL_BUILD.test(to.version)) {
      w.step('restore_store')
      await w.stopWith(to)
      if (storeRestore(dataDir, to.version)) {
        restored = true
        started = await w.startAndCheck(to)
      }
    }
    if (started.why) return await w.putBack(started.why)
    return finishDone(dataDir, w, { ...(restored ? { restored } : {}), ...(started.unchecked ? { unchecked: started.unchecked } : {}) })
  } finally {
    release()
  }
}

/** The new version answered: what no pointer, nor the switch's runner, names is removed, and the switch is `done` */
function finishDone(dataDir, w, extra = {}) {
  w.step('prune')
  let pruned = { removed: [], left: [] }
  try {
    pruned = prune(dataDir)
  } catch {
    // the next switch prunes again
  }
  return w.write({ outcome: 'done', ...pruned, ...extra })
}

/**
 * A switch with no outcome whose switcher is not alive, finished by whoever read it, by the last step written: before
 * the switch nothing changed (`failed`); from the switch until the check passed the old version is put back
 * (`put_back`); after it (`prune`), `done`.
 *
 * What answers there decides first, and a reader never stops a host the switch did not start (#1907):
 *   - the version this part of the switch starts (the new one from the switch to the check, the old one in the
 *     put-back) answering as itself is taken as it is: `done`, or `put_back`; asked within the time the switcher would
 *     have given it, or once when that is past;
 *   - any other version answering, except the new one in the put-back (which the switch started and is ending), was
 *     started by someone else meanwhile (a version from before this switch asks none). It keeps serving: the old one
 *     with the pointers back as they were (`put_back`, `kept`), another with nothing changed (`failed`, stage `kept`).
 * `start`: a host is started too (the old one, or the one that runs when nothing was switched); a caller that starts
 * one itself next passes false. Answers the switch as it is now
 */
export async function reconcile(dataDir, { env, platform = process.platform, start }) {
  const s = readSwitch(dataDir)
  if (!s || s.outcome) return s
  const l = remoteLayout(dataDir)
  if (lockIsLive(readJson(join(l.root, SWITCH_LOCK)))) return s
  const release = takeLock(l.root, s.id)
  if (!release) return readSwitch(dataDir)
  try {
    const again = readSwitch(dataDir)
    if (!again || again.outcome) return again
    const w = switchWork(dataDir, again, { env, platform })
    if (again.step === 'prune') return finishDone(dataDir, w, { interrupted: true })
    const now = readPointerFile(l.current)
    const back = ['roll_back', 'restart'].includes(again.step)
    const old = again.was.current
    if (now && (back || ['switch', 'start', 'check'].includes(again.step))) {
      // What this part of the switch starts; only it is waited for, and only when the pointers name it
      const own = back ? old?.version : again.to.version
      const left = (typeof again.at === 'number' ? again.at : 0) + (again.step === 'start' || again.step === 'restart' ? 2 : 1) * CHECK_MS - Date.now()
      const heard = own ? await w.hear(now, own, now.version === own ? Math.max(0, left) : 0) : { ok: false }
      if (heard.ok && now.version === own) {
        return back ? w.write({ outcome: 'put_back', why: again.why ?? 'interrupted', interrupted: true }) : finishDone(dataDir, w, { interrupted: true })
      }
      const other = heard.ok ? own : heard.other
      if (other && !(back && other === again.to.version)) {
        const why = `Centralu ${other} was started there during the switch`
        if (old && other === old.version) {
          setPointers(dataDir, old, again.was.previous, platform)
          return w.write({ outcome: 'put_back', why, kept: other, interrupted: true })
        }
        return w.write({ outcome: 'failed', stage: 'kept', why, kept: other, interrupted: true })
      }
    }
    if (again.step === 'stop' || again.step === 'backup') {
      w.write({ outcome: 'failed', stage: 'interrupted', why: 'interrupted before the switch', interrupted: true })
      const now = readPointerFile(l.current)
      if (start && now) await w.startAndCheck(now, ['restart', null])
      return again
    }
    if (!start) again.wasRunning = false
    return await w.putBack(again.why ?? 'interrupted', { interrupted: true })
  } finally {
    release()
  }
}

/**
 * Before `serve` or `--detach` starts a host (§10.5a "No host starts beside a switch"): `{ go: true }`; `{ go: false,
 * by, startedAt }` while a live switcher is between a stop and its start; `{ go: false, rerun }` when a switcher that died
 * was finished here and `current` now names another version than this one (`version`), which then serves instead
 */
export async function beforeHostStart({ dataDir, env, version, platform = process.platform }) {
  const s = readSwitch(dataDir)
  if (!s || s.outcome) return { go: true }
  const l = remoteLayout(dataDir)
  if (lockIsLive(readJson(join(l.root, SWITCH_LOCK)))) return QUIET_STEPS.has(s.step) ? { go: false, by: s.by, startedAt: s.startedAt } : { go: true }
  await reconcile(dataDir, { env, platform, start: false })
  const now = readPointerFile(l.current)
  if (env.CENTRALU_MANAGED === '1' && now && now.version !== version) return { go: false, rerun: now }
  return { go: true }
}

/** What `--detach` and `serve` say while a switch is under way there */
export function switchingMessage(gate) {
  return `an update from ${gate.by} started at ${clockOf(gate.startedAt)} is switching versions here; no host starts until it ends`
}

/**
 * `serve`, `--detach` and `--window` ask this before anything else (centralu.mjs), so a switcher that died is finished
 * whatever this version would refuse next: a host already answering, a missing host entry, a Node below the floor (#1907).
 * Null: go on. Otherwise the exit code, having said why or run the version `current` names now
 */
export async function gateHostStart({ env, home, version, detach, platform = process.platform, write = (s) => process.stdout.write(s) }) {
  const dataDir = serveDataDir(env, home)
  const gate = await beforeHostStart({ dataDir, env, version, platform })
  if (gate.go) return null
  if (gate.rerun) return rerunAs(dataDir, gate.rerun, process.argv.slice(2), env, platform)
  const message = switchingMessage(gate)
  if (detach) return answerLine(write, 'detach', { ok: false, how: detachHow(platform, env), reason: 'switching', by: gate.by, startedAt: gate.startedAt, message })
  say(message)
  return 1
}

/** Runs `centralu serve <args>` of the version `current` names, in this terminal; answers its exit code */
export function rerunAs(dataDir, v, args, env, platform = process.platform) {
  const { node, cli } = versionPaths(remoteLayout(dataDir), v, platform)
  return new Promise((resolve) => {
    const child = spawn(node, [cli, ...args], { env: { ...env, CENTRALU_MANAGED: '1' }, stdio: 'inherit', windowsHide: true })
    child.once('error', () => resolve(1))
    child.once('close', (code) => resolve(code ?? 1))
  })
}

/** The variable the hub's handover names the running version in (`<version> <node>`), written to `switch.runner` */
export const RUNNER_ENV = 'CENTRALU_SWITCH_RUNNER'

/**
 * `centralu serve --switch <arg>`, the handover: starts the switcher outside this ssh session (`detachHow`, as
 * `--detach` starts a host), waits until it wrote its pid, prints `{ v: 1, switch: { ok: true, id, pid } }` and exits.
 * When nothing can be started outside the session (WMI blocked, a `wsl.exe` that never ran), or the one started never
 * wrote its pid, the switch runs here in the session: a link drop then ends it, and the next reader finishes it
 * (`reconcile`). `{ ok: false, reason: 'busy', by, startedAt }` while another switch runs there, having changed
 * nothing: `switch.runner` is written only once this one may run
 */
export async function runSwitch({ env, home, raw, cliPath, execPath = process.execPath, platform = process.platform, start, write = (s) => process.stdout.write(s) }) {
  const params = decodeSwitch(raw)
  if (!params) return answerLine(write, 'switch', { ok: false, reason: 'params', message: 'this is not a switch serve --switch can read' })
  const dataDir = serveDataDir(env, home)
  const l = remoteLayout(dataDir)
  mkdirSync(l.root, { recursive: true })
  await reconcile(dataDir, { env, platform, start: false })
  const busy = () => {
    const s = readSwitch(dataDir)
    return answerLine(write, 'switch', { ok: false, reason: 'busy', by: s?.by ?? null, startedAt: s?.startedAt ?? null, message: `another switch runs there${s ? `, from ${s.by} since ${clockOf(s.startedAt)}` : ''}` })
  }
  if (lockIsLive(readJson(join(l.root, SWITCH_LOCK)))) return busy()
  const runner = parsePointer(env[RUNNER_ENV])
  if (runner) replaceFile(join(l.root, SWITCH_RUNNER), line(runner))
  const startOutside = start ?? (await import('./serve-detach.mjs')).startDetached
  const created = await startOutside({ how: detachHow(platform, env), execPath, args: [cliPath, 'serve', '--switch-run', raw, ...dataDirArg(env)], env: { ...env, CENTRALU_MANAGED: '1' }, cwd: dataDir })
  if (created.ok && (await waitUntil(() => readSwitch(dataDir)?.id === params.id, HANDOVER_MS))) {
    return answerLine(write, 'switch', { ok: true, id: params.id, pid: readSwitch(dataDir).pid })
  }
  // Never ran, or not yet: what was created is ended (WSL's `wsl.exe` that hangs, §10.4), and the switch runs here
  if (created.ok && readSwitch(dataDir)?.id !== params.id) await created.stop?.()
  let said = false
  const done = await runSwitcher({
    dataDir,
    params,
    env,
    platform,
    onLocked: () => {
      said = true
      answerLine(write, 'switch', { ok: true, id: params.id, pid: process.pid, inSession: true })
    },
  })
  if (said) return 0
  // The detached one took the lock after all
  const s = readSwitch(dataDir)
  return s?.id === params.id ? answerLine(write, 'switch', { ok: true, id: params.id, pid: s.pid }) : done === null ? busy() : 1
}

/** `centralu serve --switch-run <arg> [<data folder>]`: the detached switcher `runSwitch` started */
export async function runSwitchRun({ env, home, raw, dataDir: dataArg = null, platform = process.platform }) {
  const params = decodeSwitch(raw)
  if (!params) return 2
  const runEnv = withDataDir(env, dataArg)
  const done = await runSwitcher({ dataDir: serveDataDir(runEnv, home), params, env: runEnv, platform })
  return done ? 0 : 1
}

/**
 * `centralu serve --switch-status [--seen <id>]`: `{ v: 1, switchStatus: <switch.json> | null }`. A switch whose
 * switcher died is finished first, its old version started (`reconcile`). `--seen <id>`: that switch's outcome was
 * reported to the person, so a hub that links later does not report it again
 */
export async function runSwitchStatus({ env, home, seen = null, platform = process.platform, write = (s) => process.stdout.write(s) }) {
  const dataDir = serveDataDir(env, home)
  let s = await reconcile(dataDir, { env, platform, start: true })
  if (s && seen && s.id === seen && s.outcome && !s.seen) {
    s = { ...s, seen: true }
    replaceFile(join(remoteLayout(dataDir).root, SWITCH_FILE), `${JSON.stringify(s)}\n`)
  }
  write(`${JSON.stringify({ v: 1, switchStatus: s })}\n`)
  return 0
}
