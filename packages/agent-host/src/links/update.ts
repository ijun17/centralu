import { isLocalBuildVersion } from '@cc/protocol'
import { removeAutostart } from './autostart.js'
import { DATA_PS, DATA_SH, STEP, installCommand, installRemote, readStep, type InstallOptions, type InstallResult, type InstalledVersion } from './install.js'
import { lastLine, NOT_FOUND, remoteScript, shimNames, stopCommand, type RemoteCommand, type RemoteRun, type RemoteSpec } from './tunnel.js'

/**
 * Update, rollback and uninstall of the Centralu the hub installs on a linked machine
 * (docs/plans/remote-hub.md §10.5, phase 3 step 4), over the same ssh as the link:
 *
 *   update     install beside (install.ts, `activate: false`; the running host is not touched)
 *              → stop the running host in order (`centralu serve --stop`)
 *              → `previous` = the old `current`, `current` = the new one, each by rename
 *              → start it (`serve --detach`) → a hello from the new version within 30 s
 *              → on success remove what neither pointer names; otherwise put the old pointers back,
 *                start the old version, and fail with the end of the new host's `host.log`
 *   rollback   the same stop, switch, start and check, towards `previous`; `previous` is cleared,
 *              so it is one step back only
 *   uninstall  stop, then the boot entry removed (`serve --autostart off`, autostart.ts), then
 *              `<data>/remote/` removed; the data (store, `serve.json`, logs) stays
 *
 * Nothing is switched before the running host is gone and nothing is removed before the new one
 * answered: on Windows a running `node.exe` cannot be deleted (plan §10.5), and one step back is safe
 * only while both versions are there.
 *
 * What runs things there and what watches the link is the caller's (`HostControl`, given by
 * `LinkedMachine`), so every order and every guard here is tested against a fake.
 */

/** How long the new version has to answer after it was started (plan §10.5 step 4) */
export const CHECK_MS = 30_000

export type UpdateStep =
  | 'preflight'
  | 'registry'
  | 'node'
  | 'centralu'
  | 'build'
  | 'wait_idle'
  | 'stop'
  | 'backup'
  | 'switch'
  | 'start'
  | 'check'
  | 'restore_store'
  | 'prune'
  | 'roll_back'
  | 'autostart'
  | 'remove'

export type HostControl = {
  /** One command on the remote, in its shell's terms (`Tunnel.exec`) */
  exec: (command: RemoteCommand) => Promise<RemoteRun>
  spec: RemoteSpec
  /** The ssh target, for the sentences */
  target: string
  /** `remote-install.mjs`'s text: the pointer and prune steps run it too */
  script: string
  /**
   * Called before the running host is stopped (#1399): resolves when it may be, with a sentence for the person when it was
   * stopped with turns running; rejects to end the update with nothing switched. Absent: stopped at once
   */
  beforeStop?: () => Promise<string | null>
  /** The link stops reconnecting and starting a host on its own; called before the host is stopped */
  hold: () => void | Promise<void>
  /** `centralu serve --detach` there, through the lookup (which reads `current`) */
  start: () => Promise<void>
  /** Whether a host answering as `version` said hello within `ms`; the link reconnects for it */
  answers: (version: string, ms: number) => Promise<boolean>
  step: (step: UpdateStep) => void
}

/** `{ v: 1, stop: { ok, wasRunning, how?, message? } }`, the line `serve --stop` prints; null when there is none */
export function parseStopLine(stdout: string): { ok: boolean; wasRunning: boolean; message: string | null } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as { v?: unknown; stop?: { ok?: unknown; wasRunning?: unknown; message?: unknown } }
      if (o.v === 1 && o.stop && typeof o.stop.ok === 'boolean') {
        return { ok: o.stop.ok, wasRunning: o.stop.wasRunning === true, message: typeof o.stop.message === 'string' ? o.stop.message : null }
      }
    } catch {
      // not the line
    }
  }
  return null
}

/** Stops the host there in order. Rejects with a sentence when it is still running afterwards */
export async function stopRemoteHost(c: Pick<HostControl, 'exec' | 'spec' | 'target'>): Promise<{ wasRunning: boolean }> {
  const r = await c.exec(stopCommand(c.spec))
  // No Centralu to ask: then nothing of it runs either
  if (r.stdout.includes(NOT_FOUND)) return { wasRunning: false }
  const answer = parseStopLine(r.stdout)
  if (!answer) {
    if (/unknown option for serve: --stop/.test(r.stderr)) {
      throw new Error(`The Centralu running on ${c.target} is too old to be stopped from here: stop \`${shimNames(c.spec).centralu} serve\` there, then try again`)
    }
    const why = lastLine(r.stderr)
    throw new Error(`Stopping Centralu on ${c.target} gave no answer${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}`)
  }
  if (!answer.ok) throw new Error(`Centralu on ${c.target} could not be stopped: ${answer.message ?? 'no reason given'}`)
  return { wasRunning: answer.wasRunning }
}

/** Writes both pointers there (`remote-install.mjs`, action `pointers`), run on the Node of `run` */
async function setPointers(c: HostControl, run: InstalledVersion, current: InstalledVersion | null, previous: InstalledVersion | null) {
  const out = readStep(await c.exec(installCommand(c.spec, c.script, { action: 'pointers', version: run.version, node: run.node, current, previous })), 'done', c.target)
  return JSON.parse(out) as { current: InstalledVersion | null; previous: InstalledVersion | null }
}

async function pruneThere(c: HostControl, run: InstalledVersion): Promise<{ removed: string[]; left: string[] }> {
  const out = JSON.parse(readStep(await c.exec(installCommand(c.spec, c.script, { action: 'prune', version: run.version, node: run.node })), 'done', c.target)) as {
    removed?: string[]
    left?: string[]
  }
  return { removed: out.removed ?? [], left: out.left ?? [] }
}

const TAIL_SH = `${DATA_SH}; tail -n 12 "$d/host.log" 2>/dev/null; true\n`
const TAIL_PS = `${DATA_PS}; Get-Content -Tail 12 (Join-Path $d 'host.log') -ErrorAction SilentlyContinue\n`

/** The end of `host.log` there, in one line for a sentence ("" when there is none) */
export async function hostLogTail(c: Pick<HostControl, 'exec' | 'spec'>): Promise<string> {
  const r = await c.exec(remoteScript(c.spec, { sh: TAIL_SH, ps: TAIL_PS }))
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
  const text = lines.join(' / ')
  return text.length > 600 ? `…${text.slice(-600)}` : text
}

/** Started, then answering as `version`; otherwise why not */
async function startAndCheck(c: HostControl, version: string): Promise<string | null> {
  c.step('start')
  try {
    await c.start()
  } catch (err) {
    return (err as Error).message
  }
  c.step('check')
  return (await c.answers(version, CHECK_MS)) ? null : `it did not answer within ${CHECK_MS / 1000} s`
}

/** Copies the store there, no host running, before `before` first opens it (remote-install.mjs `storeBackup`, #1036) */
async function backupStore(c: HostControl, owner: InstalledVersion, before: string): Promise<void> {
  readStep(await c.exec(installCommand(c.spec, c.script, { action: 'store-backup', version: owner.version, node: owner.node, owner: owner.version, before })), 'done', c.target)
}

/** Puts back the copy of the store taken for `owner`, no host running; false when there is none */
async function restoreStore(c: HostControl, owner: InstalledVersion): Promise<boolean> {
  const out = JSON.parse(readStep(await c.exec(installCommand(c.spec, c.script, { action: 'store-restore', version: owner.version, node: owner.node, owner: owner.version })), 'done', c.target)) as {
    restored?: boolean
  }
  return out.restored === true
}

/** What the person is told when the store was put back as it was before a dev build */
const restoredNote = (version: string, target: string) =>
  `The store on ${target} was put back as it was before the dev build first opened it, since Centralu ${version} could not read it as the dev build left it; what was done on the dev build since is not in it`

/**
 * `to` started and checked; when it does not answer and the version left was a dev build, the store as it was before
 * that dev build first opened it is put back and `to` started once more (#1036): a dev build may have migrated the
 * store past what `to` reads, and `to` then refuses to start. Only after a dev build: the copy is the store of then,
 * and putting it back drops what was done since
 */
async function startOrRestore(c: HostControl, to: InstalledVersion, from: InstalledVersion | null): Promise<{ why: string | null; note?: string }> {
  const why = await startAndCheck(c, to.version)
  if (!why || !isLocalBuildVersion(from?.version) || isLocalBuildVersion(to.version)) return { why }
  await stopRemoteHost(c).catch(() => undefined)
  let restored = false
  try {
    restored = await restoreStore(c, to)
  } catch (err) {
    return { why: `${why}; ${(err as Error).message}` }
  }
  if (!restored) return { why }
  c.step('restore_store')
  const again = await startAndCheck(c, to.version)
  return again ? { why: again } : { why: null, note: restoredNote(to.version, c.target) }
}

/**
 * After a failed switch to `to`: the end of its log, the pointers as they were, the old host started
 * again. Always rejects, with what happened and where the machine is now. `restore`: the store is put back as it was
 * before `to` (a dev build) first opened it, which it may have migrated past what the old version reads (#1036)
 */
async function putBack(
  c: HostControl,
  to: InstalledVersion,
  why: string,
  was: { current: InstalledVersion | null; previous: InstalledVersion | null; running: boolean },
  restore = false,
): Promise<never> {
  c.step('roll_back')
  const tail = await hostLogTail(c).catch(() => '')
  const log = tail ? ` The end of its host.log: ${tail}` : ''
  const back = was.current ? `Centralu ${was.current.version}` : 'the Centralu that was there'
  try {
    // A new host that came up late, or half, goes before the old one starts on the same port
    await stopRemoteHost(c).catch(() => undefined)
    await setPointers(c, to, was.current, was.previous)
    if (restore && was.current) await restoreStore(c, was.current)
    if (was.running) await c.start()
  } catch (err) {
    throw new Error(`Centralu ${to.version} did not start on ${c.target} (${why}), and putting back ${back} failed too: ${(err as Error).message}.${log}`)
  }
  const store = restore ? ' Its store is as it was before the dev build first opened it.' : ''
  throw new Error(`Centralu ${to.version} did not start on ${c.target} (${why}); ${was.running ? `it runs ${back} again` : `${back} is back in place`}.${store}${log}`)
}

export type UpdateOptions = Omit<InstallOptions, 'exec' | 'spec' | 'target' | 'script' | 'onStep' | 'activate'>

/** `machines.update`: the whole of plan §10.5's update, against one machine */
export async function updateRemote(c: HostControl, o: UpdateOptions): Promise<InstallResult> {
  const placed = await installRemote({ ...o, exec: c.exec, spec: c.spec, target: c.target, script: c.script, activate: false, onStep: c.step })
  const next = placed.installed
  if (!next) throw new Error(`Installing on ${c.target} answered without saying what it placed; the Centralu there may predate updates from the app`)
  const was = { current: placed.current ?? null, previous: placed.previous ?? null }
  // The old `current` becomes `previous`; with none (an npm install ran there), there is nothing to go back to
  return switchRemote(c, next, was, was.current && was.current.version !== next.version ? was.current : was.previous)
}

/**
 * The update's steps after a version was placed beside (plan §10.5 steps 2 to 6): stop the running host, point
 * `current` at `next` and `previous` at `keep`, start, check, then prune; or put the pointers back and start the old
 * version again. Shared by `updateRemote` and a dev build (dev-build.ts).
 *
 * `saveStore` (a dev build, #1036): the store is copied while no host runs, before `next` first opens it, and put back
 * when `next` does not answer, so the old version finds the store it can read. Leaving a dev build the other way
 * (`next` a release), a `next` that does not answer gets the copy taken for it and one more start (`startOrRestore`)
 */
export async function switchRemote(
  c: HostControl,
  next: InstalledVersion,
  was: { current: InstalledVersion | null; previous: InstalledVersion | null },
  keep: InstalledVersion | null,
  o: { saveStore?: boolean } = {},
): Promise<InstallResult> {
  // What is working there is waited for before anything is held or stopped (#1399); the new version is already beside it
  const stoppedTurns = (await c.beforeStop?.()) ?? null
  await c.hold()
  c.step('stop')
  const { wasRunning } = await stopRemoteHost(c)
  const saveStore = o.saveStore === true && was.current !== null
  if (saveStore && was.current) {
    c.step('backup')
    try {
      await backupStore(c, was.current, next.version)
    } catch (err) {
      // Nothing was switched: the old version starts again as it was
      if (wasRunning) await c.start().catch(() => undefined)
      throw err
    }
  }
  c.step('switch')
  await setPointers(c, next, next, keep)
  const { why, note } = saveStore ? { why: await startAndCheck(c, next.version), note: undefined } : await startOrRestore(c, next, was.current)
  if (why) return putBack(c, next, why, { ...was, running: wasRunning }, saveStore)
  c.step('prune')
  const pruned = await pruneThere(c, next).catch(() => ({ removed: [], left: [] }))
  const said = [stoppedTurns, note].filter(Boolean).join(' ')
  return { current: next, previous: keep, ...pruned, ...(said ? { note: said } : {}) }
}

/** `machines.rollback`: back to `previous`, one step only (`previous` is cleared) */
export async function rollbackRemote(c: HostControl, there: { current: InstalledVersion; previous: InstalledVersion }): Promise<InstallResult> {
  await c.hold()
  c.step('stop')
  const { wasRunning } = await stopRemoteHost(c)
  c.step('switch')
  await setPointers(c, there.previous, there.previous, null)
  // Back from a dev build, the release may not read the store as the dev build left it (#1036)
  const { why, note } = await startOrRestore(c, there.previous, there.current)
  if (why) return putBack(c, there.previous, why, { current: there.current, previous: there.previous, running: wasRunning })
  return { current: there.previous, previous: null, removed: [], left: [], ...(note ? { note } : {}) }
}

const UNINSTALL_SH = `${DATA_SH}
if [ -d "$r" ]; then rm -rf "$r" || { echo "${STEP} fail remove $r"; exit 1; }; fi
echo "${STEP} uninstalled"
`
const UNINSTALL_PS = `$ErrorActionPreference = 'Stop'
${DATA_PS}
try {
  if (Test-Path $r) { Remove-Item -Recurse -Force $r }
  "${STEP} uninstalled"
} catch {
  "${STEP} fail remove $($_.Exception.Message -replace '\\s+', ' ')"
}
`

/** `<data>/remote/` removed there, in its shell's terms; the data folder's other files stay */
export function uninstallCommand(spec: RemoteSpec): RemoteCommand {
  return remoteScript(spec, { sh: UNINSTALL_SH, ps: UNINSTALL_PS })
}

/**
 * `machines.uninstall`: the host stopped, its boot entry removed, then what the hub installed removed.
 * Refused when the host would not stop: on Windows its files cannot be removed while it runs, and half
 * an install is worse than a whole one. Refused too when the boot entry would not go: left behind, it
 * would run a launcher that is no longer there at every boot. The entry goes after the stop, so a
 * host that would not stop leaves the machine as it was, boot entry included
 */
export async function uninstallRemote(c: HostControl): Promise<{ stopped: boolean }> {
  await c.hold()
  c.step('stop')
  const { wasRunning } = await stopRemoteHost(c)
  c.step('autostart')
  await removeAutostart(c)
  c.step('remove')
  readStep(await c.exec(uninstallCommand(c.spec)), 'uninstalled', c.target)
  return { stopped: wasRunning }
}
