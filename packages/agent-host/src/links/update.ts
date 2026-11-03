import { randomUUID } from 'node:crypto'
import { removeAutostart } from './autostart.js'
import { DATA_PS, DATA_SH, STEP, installRemote, readStep, type InstallOptions, type InstallResult, type InstalledVersion } from './install.js'
import { VERSION_WORD } from './registry.js'
import { lastLine, thisHubName, NOT_FOUND, remoteScript, stopCommand, type RemoteCommand, type RemoteRun, type RemoteSpec } from './tunnel.js'
import { tryParseJson } from '../json-value.js'

/**
 * Update, rollback and uninstall of the Centralu the hub installs on a linked machine
 * (docs/plans/remote-hub.md §10.5 and §10.5a), over the same ssh as the link:
 *
 *   update     install beside (install.ts, `activate: false`; the running host is not touched), wait for the turns
 *              there (`beforeStop`), then hand the switch to the machine: one command runs the new version's
 *              `serve --switch`, which stops the old host, switches the pointers, starts and checks the new version,
 *              and prunes, or puts the old version back. The hub then only reads its steps and outcome
 *              (`serve --switch-status`), so a link drop or a hub that dies leaves the machine with a host
 *   rollback   the same switch towards `previous`, run by the version that runs now; `previous` is cleared
 *   uninstall  stop, then the boot entry removed (`serve --autostart off`, autostart.ts), then
 *              `<data>/remote/` removed; the data (store, `serve.json`, logs) stays
 *
 * What runs things there and what watches the link is the caller's (`HostControl`, given by `LinkedMachine`).
 */

export type UpdateStep =
  | 'preflight'
  | 'registry'
  | 'node'
  | 'centralu'
  | 'build'
  | 'wait_idle'
  | 'wait_unread'
  | 'wait_open'
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
  /** `remote-install.mjs`'s text, which places a version */
  script: string
  /**
   * Called before the running host is stopped (#1399): resolves when it may be, with a sentence for the person when it was
   * stopped with turns running; rejects to end the update with nothing switched. Absent: stopped at once
   */
  beforeStop?: () => Promise<string | null>
  /** The link stops reconnecting and starting a host on its own; called before the switch is handed over */
  hold: () => void | Promise<void>
  step: (step: UpdateStep, count?: number) => void
  /** The machine's name, for the sentences the person reads on its row; the ssh target when not given */
  machine?: string
  /** Who hands the switch over, said there to a second hub and on a refused start; this computer's name by default */
  by?: string
  /** For tests: how often the switch is read, and how long it is followed */
  pollMs?: number
  followMs?: number
}

/** `{ v: 1, stop: { ok, wasRunning, how?, message? } }`, the line `serve --stop` prints; null when there is none */
export function parseStopLine(stdout: string): { ok: boolean; wasRunning: boolean; message: string | null } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    const o = tryParseJson(t) as { v?: unknown; stop?: { ok?: unknown; wasRunning?: unknown; message?: unknown } } | null | undefined
    if (o?.v === 1 && o.stop && typeof o.stop.ok === 'boolean') {
      return { ok: o.stop.ok, wasRunning: o.stop.wasRunning === true, message: typeof o.stop.message === 'string' ? o.stop.message : null }
    }
  }
  return null
}

/**
 * Stops the host there in order. Rejects with a sentence when it is still running afterwards. For an uninstall: an update
 * or rollback stops it through the switch
 */
export async function stopRemoteHost(c: Pick<HostControl, 'exec' | 'spec' | 'target'>, o: { forUpdate: boolean }): Promise<{ wasRunning: boolean }> {
  const r = await c.exec(stopCommand(c.spec, o))
  // No Centralu to ask: then nothing of it runs either
  if (r.stdout.includes(NOT_FOUND)) return { wasRunning: false }
  const answer = parseStopLine(r.stdout)
  if (!answer) {
    const why = lastLine(r.stderr)
    throw new Error(`Stopping Centralu on ${c.target} gave no answer${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}`)
  }
  if (!answer.ok) throw new Error(`Centralu on ${c.target} could not be stopped: ${answer.message ?? 'no reason given'}`)
  return { wasRunning: answer.wasRunning }
}

/** What the machine was asked to switch to (`serve --switch`'s argument, serve-switch.mjs `decodeSwitch`) */
export type SwitchParams = {
  id: string
  by: string
  to: InstalledVersion
  keep: InstalledVersion | null
  was: { current: InstalledVersion | null; previous: InstalledVersion | null }
  /** A dev build (#1036): the store is copied before it first opens it, and put back when it does not answer */
  saveStore: boolean
}

/** `switch.json` as `serve --switch-status` reads it there */
export type SwitchState = {
  id: string
  by: string
  to: InstalledVersion
  keep: InstalledVersion | null
  was: { current: InstalledVersion | null; previous: InstalledVersion | null }
  saveStore?: boolean
  step: string
  startedAt: number
  wasRunning?: boolean
  outcome?: 'done' | 'put_back' | 'failed'
  stage?: 'stop' | 'backup' | 'put_back' | 'interrupted'
  why?: string
  putBackWhy?: string
  stopFailed?: string | null
  log?: string
  restored?: boolean
  interrupted?: boolean
  removed?: string[]
  left?: string[]
  seen?: boolean
}

/** What the handover command prints when neither version has `serve --switch` */
export const NO_SWITCH = 'CENTRALU-NO-SWITCH'

/**
 * The handover (plan §10.5a step 3): the first of `runners` whose package has `serve --switch` runs it, on its own Node,
 * naming itself in `CENTRALU_SWITCH_RUNNER`; it writes that to `switch.runner`, which `switchStatusCommand` reads it
 * through, once it takes the switch. `NO_SWITCH` when none has
 */
export function switchCommand(spec: RemoteSpec, runners: InstalledVersion[], params: SwitchParams): RemoteCommand {
  const raw = Buffer.from(JSON.stringify(params), 'utf8').toString('base64url')
  const tries = runners.filter((v) => VERSION_WORD.test(v.version) && VERSION_WORD.test(v.node))
  const sh = `${DATA_SH}
${tries
  .map(
    (v) =>
      `if [ -f "$r/versions/${v.version}/node_modules/centralu/bin/serve-switch.mjs" ]; then CENTRALU_MANAGED=1 CENTRALU_SWITCH_RUNNER='${v.version} ${v.node}'; export CENTRALU_MANAGED CENTRALU_SWITCH_RUNNER; exec "$r/node/v${v.node}/bin/node" "$r/versions/${v.version}/node_modules/centralu/bin/centralu.mjs" serve --switch ${raw}; fi`,
  )
  .join('\n')}
echo ${NO_SWITCH}
`
  const ps = `${DATA_PS}
${tries
  .map(
    (v) =>
      `$c = Join-Path $r 'versions\\${v.version}\\node_modules\\centralu\\bin'
if (Test-Path (Join-Path $c 'serve-switch.mjs')) { $env:CENTRALU_MANAGED = '1'; $env:CENTRALU_SWITCH_RUNNER = '${v.version} ${v.node}'; & (Join-Path $r 'node\\v${v.node}\\node.exe') (Join-Path $c 'centralu.mjs') serve --switch '${raw}'; return }`,
  )
  .join('\n')}
'${NO_SWITCH}'
`
  return remoteScript(spec, { sh, ps })
}

/** `serve --switch-status` of the version that ran the last switch there; `{ v: 1, switchStatus: null }` when none did */
export function switchStatusCommand(spec: RemoteSpec, seen: string | null = null): RemoteCommand {
  const seenArg = seen && /^[0-9A-Za-z-]{8,64}$/.test(seen) ? ` --seen ${seen}` : ''
  const none = `{"v":1,"switchStatus":null}`
  const sh = `${DATA_SH}; v= n=; read -r v n < "$r/switch.runner" 2>/dev/null
case "$v" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo '${none}'; exit 0 ;; esac
case "$n" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo '${none}'; exit 0 ;; esac
CENTRALU_MANAGED=1; export CENTRALU_MANAGED; exec "$r/node/v$n/bin/node" "$r/versions/$v/node_modules/centralu/bin/centralu.mjs" serve --switch-status${seenArg}
`
  const ps = `${DATA_PS}; $f = Join-Path $r 'switch.runner'
$w = if (Test-Path $f) { @((Get-Content -Raw $f).Trim() -split '\\s+') } else { @() }
if ($w.Count -ne 2 -or $w[0] -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$' -or $w[1] -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { '${none}'; return }
$env:CENTRALU_MANAGED = '1'; & (Join-Path $r "node\\v$($w[1])\\node.exe") (Join-Path $r "versions\\$($w[0])\\node_modules\\centralu\\bin\\centralu.mjs") serve --switch-status${seenArg}
`
  return remoteScript(spec, { sh, ps })
}

/** The `{ v: 1, [key]: … }` line of `stdout`, the last one; undefined when there is none */
function lineOf(stdout: string, key: string): unknown {
  for (const l of stdout.split(/\r?\n/).reverse()) {
    const o = tryParseJson(l.trim()) as Record<string, unknown> | null | undefined
    if (o && typeof o === 'object' && o.v === 1 && key in o) return o[key]
  }
  return undefined
}

/** The switch there now, null when none ran; undefined when it could not be read (the link down, an older Centralu) */
export async function readSwitchStatus(c: Pick<HostControl, 'exec' | 'spec'>, seen: string | null = null): Promise<SwitchState | null | undefined> {
  const r = await c.exec(switchStatusCommand(c.spec, seen))
  const s = lineOf(r.stdout, 'switchStatus')
  if (s === null) return null
  return s && typeof s === 'object' && typeof (s as SwitchState).id === 'string' ? (s as SwitchState) : undefined
}

const POLL_MS = 2_000
/** Past the longest switch the switcher can take, with a link that comes back on its backoff */
const FOLLOW_MS = 15 * 60_000

/** The step the row shows for the switcher's: its `restart` is the put-back's start */
const rowStep = (s: string): UpdateStep => (s === 'restart' ? 'roll_back' : (s as UpdateStep))

/** Reads the switch `id` there until it has an outcome, showing its steps; a read that fails is tried again later */
async function follow(c: HostControl, id: string): Promise<SwitchState> {
  const until = Date.now() + (c.followMs ?? FOLLOW_MS)
  const poll = c.pollMs ?? POLL_MS
  let shown: string | null = null
  let wait = poll
  for (;;) {
    const s = await readSwitchStatus(c).catch(() => undefined)
    if (s?.id === id) {
      wait = poll
      if (s.step !== shown) c.step(rowStep((shown = s.step)))
      if (s.outcome) return s
    } else wait = Math.min(wait * 2, 30_000)
    if (Date.now() > until) {
      const machine = c.machine ?? c.target
      throw new Error(`The update of ${machine} could not be followed to its end from this computer; how it ended is shown once ${machine} is reached again`)
    }
    await new Promise((r) => setTimeout(r, wait))
  }
}

/** What the person is told when the store was put back as it was before a dev build */
const restoredNote = (version: string, target: string) =>
  `The store on ${target} was put back as it was before the dev build first opened it, since Centralu ${version} could not read it as the dev build left it; what was done on the dev build since is not in it`

/** A finished switch as the update's result, or the sentence it failed with (thrown) */
export function switchResult(s: SwitchState, target: string, stoppedTurns: string | null = null, machine = target): InstallResult {
  const from = s.was.current
  const back = from ? `Centralu ${from.version}` : 'the Centralu that was there'
  const log = s.log ? ` The end of its host.log: ${s.log}` : ''
  if (s.outcome === 'done') {
    const note = [stoppedTurns, s.restored ? restoredNote(s.to.version, target) : null].filter(Boolean).join(' ')
    return { current: s.to, previous: s.keep, removed: s.removed ?? [], left: s.left ?? [], ...(note ? { note } : {}) }
  }
  if (s.outcome === 'put_back') {
    if (s.interrupted) throw new Error(`The update of ${machine} to Centralu ${s.to.version} was interrupted; it runs ${back} again`)
    const store = s.saveStore ? ' Its store is as it was before the dev build first opened it.' : ''
    throw new Error(`Centralu ${s.to.version} did not start on ${target} (${s.why}); ${s.wasRunning === false ? `${back} is back in place` : `it runs ${back} again`}.${store}${log}`)
  }
  switch (s.stage) {
    case 'stop':
      throw new Error(`Centralu on ${target} could not be stopped: ${s.why ?? 'no reason given'}`)
    case 'backup':
      throw new Error(`The store on ${target} could not be copied before the dev build first opened it (${s.why ?? 'no reason given'}); the release was started again and nothing was switched`)
    case 'interrupted':
      throw new Error(`The update of ${machine} to Centralu ${s.to.version} was interrupted before the switch; nothing was switched`)
    default: {
      const stop = s.stopFailed ? ` (after Centralu on ${target} could not be stopped: ${s.stopFailed})` : ''
      throw new Error(`Centralu ${s.to.version} did not start on ${target} (${s.why}), and putting back ${back} failed too: ${s.putBackWhy}${stop}.${log}`)
    }
  }
}

/** The time a switch started, as the person reads it: HH:MM, as the machine says it too (serve-switch.mjs `clockOf`) */
const clock = (at: number | null | undefined) => (typeof at === 'number' ? new Date(at).toTimeString().slice(0, 5) : 'an unknown time')

/**
 * Hands a switch to the machine and follows it to its outcome (plan §10.5a steps 3 to 5): the turns there are waited
 * for, the link is held, then one command runs `serve --switch` of the first of `runners` that has it. Shared by the
 * update, the rollback and a dev build (dev-build.ts)
 */
export async function handOver(c: HostControl, runners: InstalledVersion[], p: Omit<SwitchParams, 'id' | 'by'>): Promise<InstallResult> {
  const machine = c.machine ?? c.target
  const busy = (by: unknown, at: unknown) =>
    new Error(`An update of ${machine} started from ${typeof by === 'string' ? by : 'another computer'} at ${clock(typeof at === 'number' ? at : null)} is still running; try again when it ends`)
  // A switch under way there refuses this one before anything here waits, holds or stops (#1907); one whose switcher died is finished by this read
  const there = await readSwitchStatus(c).catch(() => undefined)
  if (there && !there.outcome) throw busy(there.by, there.startedAt)
  // What is working there is waited for before anything is held or stopped (#1399); the new version is already beside it
  const stoppedTurns = (await c.beforeStop?.()) ?? null
  await c.hold()
  c.step('stop')
  const params: SwitchParams = { id: randomUUID(), by: c.by ?? thisHubName(), ...p }
  const r = await c.exec(switchCommand(c.spec, runners, params))
  if (r.stdout.includes(NO_SWITCH)) throw new Error(`Update ${machine} first: both versions there predate updates the machine runs itself`)
  const answer = lineOf(r.stdout, 'switch') as { ok?: unknown; reason?: unknown; by?: unknown; startedAt?: unknown; message?: unknown } | undefined
  // Begun since the read above
  if (answer?.ok === false && answer.reason === 'busy') throw busy(answer.by, answer.startedAt)
  if (answer?.ok === false) throw new Error(`${c.target} did not take the update: ${typeof answer.message === 'string' ? answer.message : 'no reason given'}`)
  // No answer at all: the command may have died with the link after the switcher started; the switch says
  if (answer === undefined) {
    const s = await readSwitchStatus(c).catch(() => undefined)
    if (s?.id !== params.id) {
      const why = lastLine(r.stderr)
      throw new Error(`Handing the update to ${c.target} gave no answer${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}; nothing was switched`)
    }
  }
  const s = await follow(c, params.id)
  // Reported here: a hub that links later does not report it again
  await readSwitchStatus(c, params.id).catch(() => undefined)
  // The versions as this hub knows them (a dev build's `source` with them), not as the machine echoes them
  return { ...switchResult(s, c.target, stoppedTurns, machine), current: p.to, previous: p.keep }
}

export type UpdateOptions = Omit<InstallOptions, 'exec' | 'spec' | 'target' | 'script' | 'onStep' | 'activate'>

/** `machines.update`: the whole of plan §10.5's update, against one machine */
export async function updateRemote(c: HostControl, o: UpdateOptions): Promise<InstallResult> {
  const placed = await installRemote({ ...o, exec: c.exec, spec: c.spec, target: c.target, script: c.script, activate: false, onStep: c.step })
  const next = placed.installed
  if (!next) throw new Error(`Installing on ${c.target} answered without saying what it placed; the Centralu there may predate updates from the app`)
  const was = { current: placed.current ?? null, previous: placed.previous ?? null }
  // The old `current` becomes `previous`; with none (an npm install ran there), there is nothing to go back to
  const keep = was.current && was.current.version !== next.version ? was.current : was.previous
  // The new version runs the switch; leaving a dev build for a release from before it, the dev build does
  return handOver(c, [next, ...(was.current ? [was.current] : [])], { to: next, keep, was, saveStore: false })
}

/** `machines.rollback`: back to `previous`, one step only (`previous` is cleared); the version that runs now switches */
export function rollbackRemote(c: HostControl, there: { current: InstalledVersion; previous: InstalledVersion }): Promise<InstallResult> {
  return handOver(c, [there.current, there.previous], { to: there.previous, keep: null, was: { current: there.current, previous: there.previous }, saveStore: false })
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
  const { wasRunning } = await stopRemoteHost(c, { forUpdate: false })
  c.step('autostart')
  await removeAutostart(c)
  c.step('remove')
  readStep(await c.exec(uninstallCommand(c.spec)), 'uninstalled', c.target)
  return { stopped: wasRunning }
}
