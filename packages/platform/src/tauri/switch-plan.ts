/**
 * What the window's build bar shows, and what a restart into this window's build costs
 * (docs/runtime-lessons/quit-relaunch-update.md UP7, UP8). Pure, so the wording rules are tested without a webview.
 */

import { isNewerVersion } from '@cc/protocol/client'

/** Where a build came from, as the keeper records it */
export type Build = { commit: string; builtAt?: string; version?: string; bundlePath?: string }

export type RestartPlan = {
  /** Ask first: something can be lost */
  confirm: boolean
  /** What can be lost, for the confirmation */
  loses: string
}

/** What a restart costs when the keeper stops for an update, as "Apply now" does */
export const UPDATE_STOP_LOSES =
  'Running turns stop and go on once this build is up, and open terminals and Run commands start again there. ' +
  'A waiting approval or question is asked again.'

/**
 * Whether to ask before a restart into this build (docs/runtime-lessons/quit-relaunch-update.md UP7). Unknown is busy:
 * a confirmation too many costs a click, one too few a turn. A plain stop always asks: a keeper of beta.48 or older
 * reports idle while its host is down and still holds agents and terminals.
 */
export function restartPlan(b: { busy?: boolean; stopsForUpdate?: boolean }): RestartPlan {
  const forUpdate = b.stopsForUpdate === true
  return { confirm: b.busy !== false || !forUpdate, loses: forUpdate ? UPDATE_STOP_LOSES : RESTART_COMPLETELY_LOSES }
}

/**
 * Whether build `a` is newer than `b` (docs/runtime-lessons/quit-relaunch-update.md UP7): a higher semver,
 * prereleases included, then a later `builtAt` (the ISO time in `bundle-info.json`, or the keeper's whole seconds).
 * What cannot be ordered, a host run from source included, is not newer.
 */
export function isNewerBuild(a: Build | undefined, b: Build | undefined): boolean {
  if (!a || !b || isDev(a) || isDev(b)) return false
  const va = semverOf(a.version)
  const vb = semverOf(b.version)
  if (!va || !vb) return false
  if (isNewerVersion(va, vb)) return true
  if (isNewerVersion(vb, va)) return false
  const ta = builtAtMs(a.builtAt)
  const tb = builtAtMs(b.builtAt)
  return ta !== null && tb !== null && ta > tb
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/

/** The version without build metadata, or null when it is not one `isNewerVersion` can order */
function semverOf(v: string | undefined): string | null {
  const t = v?.trim().replace(/^v/, '')
  if (!t || !SEMVER.test(t)) return null
  return t.replace(/\+.*$/, '')
}

/** `BuildSource::dev()`: a host run from source, which every source run shares */
function isDev(b: Build): boolean {
  return b.commit.trim() === 'dev'
}

/** An ISO time, or whole seconds since the epoch (`BuildSource::from_host_dir`'s fallback) */
function builtAtMs(t: string | undefined): number | null {
  const s = t?.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s) * 1000
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

/** The window's build is newer than the host's and the keeper's, each where that is another build */
function forwardOnly(b: {
  app?: Build
  host?: Build
  keeper?: Build
  sameBuild?: boolean
  keeperSameBuild?: boolean
}): boolean {
  if (b.sameBuild === false && !isNewerBuild(b.app, b.host)) return false
  if (b.keeperSameBuild === false && !isNewerBuild(b.app, b.keeper)) return false
  return true
}

export type AutoRestartInput = {
  build: {
    app?: Build
    host?: Build
    keeper?: Build
    busy?: boolean
    /** The keeper can stop its host for an update, so the restart continues the turns */
    stopsForUpdate?: boolean
    sameBuild?: boolean
    keeperSameBuild?: boolean
  }
  /** "Apply updates automatically when idle" is on (#352) */
  autoApply: boolean
  /** This window already restarted once by itself; it never does so twice */
  tried: boolean
  /** The person dismissed the bar ("Not now") */
  dismissed: boolean
}

/** Whether the window restarts into its build by itself: docs/runtime-lessons/quit-relaunch-update.md UP7 says when */
export function autoRestart(i: AutoRestartInput): boolean {
  const b = i.build
  const behind = b.sameBuild === false || b.keeperSameBuild === false
  return behind && i.autoApply && !i.tried && !i.dismissed && b.busy === false && b.stopsForUpdate === true && forwardOnly(b)
}

export type BuildBar =
  | { kind: 'none' }
  /** `older`: the build running there is newer than this window's, so the restart goes back */
  | { kind: 'other'; who: 'host' | 'keeper'; older?: true }
  /** A macOS release started its keeper without the permission shell (docs/plans/thin-shell.md §6) */
  | { kind: 'shell'; text: string; detail: string }

/** `notify`: a release says so on screen; a local build only writes keeper.log */
export type ShellStart = {
  started: boolean
  /** The shell's refusal (`content`, `downgrade`, …) or the window's (`install`, `open`, `no-report`, …) */
  reason?: string
  message?: string
  notify: boolean
  shellVersion?: number
}

export type BuildBarInput = {
  build: {
    mode: 'keeper' | 'direct' | 'serve'
    app?: Build
    host?: Build
    keeper?: Build
    sameBuild?: boolean
    keeperSameBuild?: boolean
    shell?: ShellStart
  }
  /** "Not now" was pressed, for as long as the window stays behind */
  dismissed: boolean
  /** Dismissed for the window's life */
  dismissedShell?: boolean
}

/** The words a full quit and a restart that stops an earlier keeper share (#387) */
export const COMPLETELY_STOPS = 'Also stops agents, terminals and running commands.'

/** "Quit completely" on this computer's `centralu serve` host (#1466); closing the window leaves it running */
export const SERVE_COMPLETELY_STOPS =
  'Quit completely stops the host on this computer (centralu serve) with its agents, terminals and running commands, and ends the link a hub has to this computer.'

/** What a restart costs when the keeper cannot stop for an update */
export const RESTART_COMPLETELY_LOSES =
  `${COMPLETELY_STOPS} Conversations are saved and resume on this build in a moment; waiting ` +
  `approvals have to be asked again.`

/** Another build first, then the permission-shell note of a release until dismissed */
export function buildBar(i: BuildBarInput): BuildBar {
  const b = i.build
  if (b.mode !== 'keeper') return { kind: 'none' }
  if ((b.sameBuild === false || b.keeperSameBuild === false) && !i.dismissed) {
    const who = b.sameBuild === false ? 'host' : 'keeper'
    const older = isNewerBuild(who === 'host' ? b.host : b.keeper, b.app)
    return { kind: 'other', who, ...(older ? { older: true as const } : {}) }
  }
  const sh = b.shell
  if (sh && !sh.started && sh.notify && !i.dismissedShell) {
    return { kind: 'shell', text: shellBarText(sh.reason), detail: sh.message ?? '' }
  }
  return { kind: 'none' }
}

/** What it costs comes first, then the reason in a few words; the full one is on hover */
export function shellBarText(reason: string | undefined): string {
  const why: Record<string, string> = {
    content: "this build's signed content did not verify",
    'shell-too-old': 'the permission shell is older than this version needs',
    downgrade: 'this version is older than one that already ran here',
    copy: 'the content could not be copied into the data folder',
    'keeper-start': 'the shell could not start the background keeper',
    'keeper-exited': 'the shell could not start the background keeper',
    'keeper-timeout': 'the shell could not start the background keeper',
    install: 'the permission shell could not be installed',
    open: 'macOS did not open the permission shell',
    'no-report': 'the permission shell did not answer',
  }
  const words = (reason && why[reason]) || 'the permission shell did not start it'
  return `Agents started without the permission shell (${words}). They work, but macOS may ask for permissions again after an update.`
}

/** A build in a few words: its version and commit (`0.1.0-beta.10, 2ffcaec5`), or just the commit */
function shortBuild(b: Build | undefined): string {
  if (!b) return 'unknown'
  return b.version ? `${b.version}, ${b.commit}` : `build ${b.commit}`
}

/** The bar's line when this window is of an older build than the one running (#352) */
export function olderBuildText(app: Build | undefined, running: Build | undefined): string {
  return `This window is an older build (${shortBuild(app)}) than the one running (${shortBuild(running)}).`
}
