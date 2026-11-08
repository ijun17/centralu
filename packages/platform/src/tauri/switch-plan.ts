/**
 * What the window's build bar shows, and what a restart into this window's build costs (#280, #387, #1895 step 4 PR 3).
 * Pure, so the wording rules are tested without a webview.
 *
 * A window of one build attached to a keeper or host of another (the app was updated or opened by hand while the keeper
 * ran on) offers a restart into its own build. The window stops the keeper (`restart_keeper`): for an update when the keeper
 * can (`stopsForUpdate`, #1895 step 3 and later), so this window's host continues the turns it cut and opens its terminals
 * and Run commands again; with a plain stop otherwise, which ends what that keeper holds as "Quit completely" does. Then the
 * window starts a keeper of its own build. It asks first only when something is running (`restartPlan`).
 *
 * Until #1895 step 4 this was a switch: the keeper's blue-green swap, with its phases on the bar. No window asks for one now.
 *
 * A window restarts by itself only with "Apply updates automatically when idle" on, only when nothing is running, and only
 * forward (`isNewerBuild`): opening an older build's window (a backed-up app, an older local build) must not quietly
 * downgrade the keeper and the host. Going back to an older build stays a button press, and the bar says it is an older
 * build.
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

/** What a restart into this build costs when the keeper stops for an update, as "Apply now" does */
export const UPDATE_STOP_LOSES =
  'Running turns stop and go on once this build is up, and open terminals and Run commands start again there. ' +
  'A waiting approval or question is asked again.'

/**
 * Whether to ask before a restart into this build, and what to say. Asked when something can be lost: a session working
 * or waiting, a terminal or a command running (`busy`). Unknown counts as busy, because a confirmation too many costs a
 * click and one too few costs a turn. A restart that is a plain stop (the keeper cannot stop its host for an update) always
 * asks: such a keeper reports itself idle while its host is down, and one of beta.48 or older still holds agents and
 * terminals then (#1895 step 4 PR 3 review).
 */
export function restartPlan(b: { busy?: boolean; stopsForUpdate?: boolean }): RestartPlan {
  const forUpdate = b.stopsForUpdate === true
  return { confirm: b.busy !== false || !forUpdate, loses: forUpdate ? UPDATE_STOP_LOSES : RESTART_COMPLETELY_LOSES }
}

/**
 * Whether build `a` is newer than build `b`, for restarting by itself only forward (#352).
 *
 * Newer means a higher app version (semver, prereleases included: 0.1.0-beta.11 is newer than
 * 0.1.0-beta.10), and on equal versions a later build time (`builtAt`: the ISO time in
 * `bundle-info.json`, or the whole seconds the keeper falls back to when that file has none). When
 * either side lacks what it takes to order them (no version, a version that is not semver, equal
 * versions without both build times, a host run from source), `a` is **not** newer: a restart
 * nobody can tell to be forward is left to the person.
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

/**
 * The window's build is newer than every build a restart would replace: the host's when that is of
 * another build, and the keeper's when that is (#352, forward only).
 */
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

/**
 * Whether a window of a newer build than its keeper or host restarts into its build by itself (#352): only with "Apply
 * updates automatically when idle" on, only when the keeper reports nothing running, never twice from one window and never
 * after "Not now". Only forward: never when the window's build is not newer than the host or keeper it would replace. Only
 * a keeper that stops for an update: a plain stop is left to the button, whose confirmation says what it stops, since a
 * keeper whose host is down reports idle whatever it still holds (`restartPlan`).
 */
export function autoRestart(i: AutoRestartInput): boolean {
  const b = i.build
  const behind = b.sameBuild === false || b.keeperSameBuild === false
  return behind && i.autoApply && !i.tried && !i.dismissed && b.busy === false && b.stopsForUpdate === true && forwardOnly(b)
}

/** What the window's build bar shows: one of these, or nothing */
export type BuildBar =
  | { kind: 'none' }
  /**
   * The host or the keeper is of another build than this window: offer a restart into this build. `older`: the build
   * running there is newer than this window's, so the restart goes back.
   */
  | { kind: 'other'; who: 'host' | 'keeper'; older?: true }
  /**
   * A macOS release started its keeper without the permission shell (docs/plans/thin-shell.md §6):
   * agents work, permissions follow this build. `detail` is the shell's or the window's own reason.
   */
  | { kind: 'shell'; text: string; detail: string }

/**
 * How the window's last keeper start went through the macOS shell (`ShellHostBuild.shell`). Absent when
 * none was tried. `notify`: a release says so on screen; a local build only writes keeper.log.
 */
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
  /** The shell note was dismissed (it stays dismissed for the window's life) */
  dismissedShell?: boolean
}

/**
 * What a full quit, and a restart that stops an earlier keeper, stop, in the words both use (#387). The keeper and the host
 * stop, and with them every agent process, terminal and running command; nothing else does that.
 */
export const COMPLETELY_STOPS = 'Also stops agents, terminals and running commands.'

/**
 * What "Quit completely" stops in a window on the computer's `centralu serve` host (#1466): the host is the one a hub's
 * link uses too, so stopping it ends that link as well. Closing the window alone leaves it running.
 */
export const SERVE_COMPLETELY_STOPS =
  'Quit completely stops the host on this computer (centralu serve) with its agents, terminals and running commands, and ends the link a hub has to this computer.'

/** What a restart into this build costs when the keeper cannot stop for an update, for its confirmation */
export const RESTART_COMPLETELY_LOSES =
  `${COMPLETELY_STOPS} Conversations are saved and resume on this build in a moment; waiting ` +
  `approvals have to be asked again.`

/**
 * What the bar shows (#280, #387). A host or keeper of another build: the builds and a restart into this build, or, when
 * the build running there is newer than this window's, that this window is an older build (#352). Otherwise the keeper
 * started without the permission shell, in a release (`shellBarText`), until dismissed.
 */
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

/**
 * The bar's line when the keeper started without the permission shell. What it costs comes first:
 * agents run either way, but macOS permissions belong to this build and may be asked for again
 * after an update. The reason in a few words follows; the full one is on hover.
 */
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
export function shortBuild(b: Build | undefined): string {
  if (!b) return 'unknown'
  return b.version ? `${b.version}, ${b.commit}` : `build ${b.commit}`
}

/** The bar's line when this window is of an older build than the one running (#352) */
export function olderBuildText(app: Build | undefined, running: Build | undefined): string {
  return `This window is an older build (${shortBuild(app)}) than the one running (${shortBuild(running)}).`
}
