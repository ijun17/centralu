import { removeAutostart } from './autostart.js'
import { DATA_PS, DATA_SH, STEP, installCommand, installRemote, readStep, type InstallOptions, type InstallResult, type InstalledVersion } from './install.js'
import { lastLine, NOT_FOUND, remoteScript, stopCommand, type RemoteRun, type RemoteSpec } from './tunnel.js'

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

export type UpdateStep = 'preflight' | 'registry' | 'node' | 'centralu' | 'stop' | 'switch' | 'start' | 'check' | 'prune' | 'roll_back' | 'autostart' | 'remove'

export type HostControl = {
  /** One command on the remote, in its shell's terms (`Tunnel.exec`) */
  exec: (command: string) => Promise<RemoteRun>
  spec: RemoteSpec
  /** The ssh target, for the sentences */
  target: string
  /** `remote-install.mjs`'s text: the pointer and prune steps run it too */
  script: string
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
      throw new Error(`The Centralu running on ${c.target} is too old to be stopped from here: stop \`centralu serve\` there, then try again`)
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

/**
 * After a failed switch to `to`: the end of its log, the pointers as they were, the old host started
 * again. Always rejects, with what happened and where the machine is now
 */
async function putBack(c: HostControl, to: InstalledVersion, why: string, was: { current: InstalledVersion | null; previous: InstalledVersion | null; running: boolean }): Promise<never> {
  c.step('roll_back')
  const tail = await hostLogTail(c).catch(() => '')
  const log = tail ? ` The end of its host.log: ${tail}` : ''
  const back = was.current ? `Centralu ${was.current.version}` : 'the Centralu that was there'
  try {
    // A new host that came up late, or half, goes before the old one starts on the same port
    await stopRemoteHost(c).catch(() => undefined)
    await setPointers(c, to, was.current, was.previous)
    if (was.running) await c.start()
  } catch (err) {
    throw new Error(`Centralu ${to.version} did not start on ${c.target} (${why}), and putting back ${back} failed too: ${(err as Error).message}.${log}`)
  }
  throw new Error(`Centralu ${to.version} did not start on ${c.target} (${why}); ${was.running ? `it runs ${back} again` : `${back} is back in place`}.${log}`)
}

export type UpdateOptions = Omit<InstallOptions, 'exec' | 'spec' | 'target' | 'script' | 'onStep' | 'activate'>

/** `machines.update`: the whole of plan §10.5's update, against one machine */
export async function updateRemote(c: HostControl, o: UpdateOptions): Promise<InstallResult> {
  const placed = await installRemote({ ...o, exec: c.exec, spec: c.spec, target: c.target, script: c.script, activate: false, onStep: c.step })
  const next = placed.installed
  if (!next) throw new Error(`Installing on ${c.target} answered without saying what it placed; the Centralu there may predate updates from the app`)
  const was = { current: placed.current ?? null, previous: placed.previous ?? null }
  await c.hold()
  c.step('stop')
  const { wasRunning } = await stopRemoteHost(c)
  c.step('switch')
  // The old `current` becomes `previous`; with none (an npm install ran there), there is nothing to go back to
  const keep = was.current && was.current.version !== next.version ? was.current : was.previous
  await setPointers(c, next, next, keep)
  const why = await startAndCheck(c, next.version)
  if (why) return putBack(c, next, why, { ...was, running: wasRunning })
  c.step('prune')
  const pruned = await pruneThere(c, next).catch(() => ({ removed: [], left: [] }))
  return { current: next, previous: keep, ...pruned }
}

/** `machines.rollback`: back to `previous`, one step only (`previous` is cleared) */
export async function rollbackRemote(c: HostControl, there: { current: InstalledVersion; previous: InstalledVersion }): Promise<InstallResult> {
  await c.hold()
  c.step('stop')
  const { wasRunning } = await stopRemoteHost(c)
  c.step('switch')
  await setPointers(c, there.previous, there.previous, null)
  const why = await startAndCheck(c, there.previous.version)
  if (why) return putBack(c, there.previous, why, { current: there.current, previous: there.previous, running: wasRunning })
  return { current: there.previous, previous: null, removed: [], left: [] }
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
export function uninstallCommand(spec: RemoteSpec): string {
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
