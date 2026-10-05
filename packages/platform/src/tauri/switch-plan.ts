/**
 * What switching the host to this window's build costs, and how to say a swap's progress (#280,
 * option C step 3). Pure, so the wording rules are tested without a webview.
 *
 * Since step 4 a switch also moves the keeper (the background process that holds the host and the
 * agents) to the new build first: it hands its handles to the new build's keeper and exits, which
 * stops nothing. When only the keeper is behind, that is all a switch does.
 *
 * Switching is a blue-green swap: the keeper starts the new build next to the running host, the
 * running host gets up to 10 seconds to finish the calls it serves itself (orchestrator and app
 * tools, RPCs), and the front door moves to the new host. Whether agents survive depends on the
 * running host: with step 2 it hands them over (`keepsAgents`); before that, the swap's detach still
 * stops them, as a quit does.
 *
 * A keeper that cannot hand itself over leaves the host swap to go ahead under it, and then stays
 * on its build until it next starts (#387, `keeperStaysBehind`). The bar says so calmly and offers
 * "Restart completely" instead of a switch that would only fail again.
 */

/** Where a build came from, as the keeper records it */
export type SwapBuild = { commit: string; builtAt?: string; version?: string; bundlePath?: string }

export type SwapPhase = 'handing_over' | 'starting' | 'standby' | 'draining' | 'activating' | 'done' | 'failed'

/** The keeper's account of the current or last swap */
export type SwapView = {
  phase: SwapPhase
  target: SwapBuild
  from?: SwapBuild
  message?: string
  /** Failed after the old host had drained, and the old build was started again */
  rolledBack?: boolean
  /** In-process calls the old host cut at the drain bound */
  cut?: string[]
  /** The keeper could not move to the new build (#280 step 4); the host switch went ahead anyway */
  keeperMessage?: string
  startedAt: number
}

export type SwitchPlan = {
  /** Ask first: something can be lost */
  confirm: boolean
  /** What can be lost, for the confirmation */
  loses: string
}

/** The keeper's drain bound, in the words the person reads */
const DRAIN_WORDS = '10 seconds'

/**
 * Whether to ask before switching, and what to say.
 *
 * Asked only when something can be lost: a session working or waiting, a terminal or a command
 * running (`busy`). Unknown counts as busy, because a confirmation too many costs a click and one
 * too few costs a turn.
 */
export function switchPlan(b: { keepsAgents?: boolean; busy?: boolean; sameBuild?: boolean; keeperSameBuild?: boolean }): SwitchPlan {
  // Only the keeper is behind: moving it hands every handle over and stops nothing (#280 step 4)
  if (b.sameBuild === true && b.keeperSameBuild === false) {
    return { confirm: false, loses: 'Nothing stops: agents, terminals and this window carry on.' }
  }
  const confirm = b.busy !== false
  if (b.keepsAgents === true) {
    return {
      confirm,
      loses:
        `Agents keep running and this window reconnects in a moment. A tool call Centralu serves itself ` +
        `(an orchestrator or app tool) that is still running after ${DRAIN_WORDS} is stopped, and the agent ` +
        `is told to try it again.`,
    }
  }
  return {
    confirm,
    loses:
      `This build cannot hand running agents over yet, so running turns stop and agent processes, ` +
      `terminals and commands restart on the new build. Conversations are saved and resume there; ` +
      `waiting approvals have to be asked again. Tool calls Centralu serves itself get up to ${DRAIN_WORDS} ` +
      `to finish first.`,
  }
}

export type AutoSwitchInput = {
  build: {
    app?: SwapBuild
    keepsAgents?: boolean
    busy?: boolean
    sameBuild?: boolean
    keeperSameBuild?: boolean
    /** Started by "Apply now" (#352): the keeper held on through the relaunch and said so */
    relaunched?: boolean
    swap?: SwapView
  }
  /** "Apply updates automatically when idle" is on (#352) */
  autoApply: boolean
  /** This window already switched or asked once by itself; it never does so twice */
  tried: boolean
  /** The person dismissed the bar ("Not now") */
  dismissed: boolean
}

/**
 * What a window of a newer build than its keeper or host does by itself (#352):
 *
 * - `switch`: switch now, without a click. Only for a window started by "Apply now", or with
 *   "Apply updates automatically when idle" on, and only when the plan says nothing can be lost
 *   (`switchPlan`: nothing running, or only the keeper behind).
 * - `ask`: something can be lost, and the person pressed "Apply now" a moment ago: open the
 *   question now rather than leave them to find the bar.
 * - `wait`: something can be lost and nobody pressed anything (the automatic mode): wait until it
 *   cannot, which the next activity report brings.
 * - `none`: the bar as before.
 *
 * Never while a swap runs, never twice from one window (a failure stays on the bar with "Try
 * again"), and never after "Not now".
 */
export function autoSwitch(i: AutoSwitchInput): 'switch' | 'ask' | 'wait' | 'none' {
  const b = i.build
  const behind = b.sameBuild === false || b.keeperSameBuild === false
  if (!behind || i.tried || i.dismissed || swapRunning(b.swap)) return 'none'
  // The keeper already said it cannot move to this build: asking again would only fail again
  if (keeperStaysBehind(b)) return 'none'
  if (!b.relaunched && !i.autoApply) return 'none'
  if (!switchPlan(b).confirm) return 'switch'
  if (i.autoApply) return 'wait'
  return 'ask'
}

/** One line for the bar while a swap runs, or after it failed; null when there is nothing to show */
export function swapProgressText(s: SwapView | undefined): string | null {
  if (!s) return null
  switch (s.phase) {
    case 'handing_over':
      return 'Moving the background keeper to the new build…'
    case 'starting':
      return 'Starting the new build next to the running one…'
    case 'standby':
      return 'The new build is ready to take over…'
    case 'draining':
      return `Letting running calls finish (up to ${DRAIN_WORDS})…`
    case 'activating':
      return 'Handing over to the new build. Reconnecting…'
    case 'done':
      return s.keeperMessage
        ? `Switched builds, but the background keeper stays on the previous build: ${firstLine(s.keeperMessage)}.`
        : null
    case 'failed': {
      const after = s.rolledBack
        ? ' The previous build was started again.'
        : ' The running build was not touched and is still serving.'
      return `Could not switch builds: ${firstLine(s.message ?? 'no reason given')}.${after}`
    }
  }
}

/**
 * The background keeper stayed on its build while the host moved to this window's (#387).
 *
 * A keeper hands itself over to the new build's keeper before the host swap, and a handoff that
 * fails rolls back and leaves the host swap to go ahead under the old keeper (`move_keeper`, which
 * beta.10 does too). The fix for a handoff that fails lives in the **sending** keeper, so a keeper
 * of an older build can fail the same way on every try: beta.10's keeper fails with "Message too
 * long" on macOS once it holds enough descriptors (#387). Offering "Switch to this build" again
 * then loops forever, and the second try even reads as a failure, although the window already runs
 * against a host of its own build.
 *
 * So: the host is on this window's build, the keeper is not, and the last swap was to this build
 * and says why the keeper stayed (`keeperMessage`). Nothing is wrong that a switch could fix; the
 * keeper moves when it next starts, which a full restart does now.
 */
export function keeperStaysBehind(b: {
  app?: SwapBuild
  sameBuild?: boolean
  keeperSameBuild?: boolean
  swap?: SwapView
}): boolean {
  const s = b.swap
  if (b.sameBuild !== true || b.keeperSameBuild !== false || !s?.keeperMessage) return false
  if (s.phase !== 'done' && s.phase !== 'failed') return false
  return !b.app || sameBuildKey(s.target, b.app)
}

/** What the window's build bar shows: one of these, or nothing */
export type BuildBar =
  | { kind: 'none' }
  /** A swap is running: its phase, in words */
  | { kind: 'switching'; text: string }
  /** The host is on this build and the keeper stayed behind: a calm note, and a full restart on offer */
  | { kind: 'keeper_later'; text: string; detail?: string }
  /**
   * How the last swap ended, until dismissed: a failure, or a switch that left the keeper behind.
   * `retry`: the window is still behind, so the switch is offered again ("Try again").
   */
  | { kind: 'failed' | 'notice'; text: string; retry: boolean }
  /** The host or the keeper is of another build than this window: offer to switch */
  | { kind: 'other'; who: 'host' | 'keeper' }

export type BuildBarInput = {
  build: {
    mode: 'keeper' | 'direct'
    app?: SwapBuild
    sameBuild?: boolean
    keeperSameBuild?: boolean
    swap?: SwapView
  }
  /** "Not now" or "Dismiss" was pressed, for as long as the window stays behind */
  dismissed: boolean
  /** The swap (`startedAt`) whose failure or note was dismissed */
  dismissedSwap: number | null
}

/** The note for a keeper that stays on its build while the host runs this one */
export const KEEPER_LATER_TEXT = 'Running this build. The background keeper moves to it the next time it restarts.'

/**
 * What a full restart and a full quit stop, in the words both use (#387). The keeper and the host
 * stop, and with them every agent process, terminal and running command; nothing else does that.
 */
export const COMPLETELY_STOPS = 'Also stops agents, terminals and running commands.'

/** What restarting the keeper costs, for its confirmation */
export const RESTART_COMPLETELY_LOSES =
  `${COMPLETELY_STOPS} Conversations are saved and resume on this build in a moment; waiting ` +
  `approvals have to be asked again.`

/**
 * What the bar shows (#280, #387). In order:
 *
 * 1. A swap running: its phase.
 * 2. The keeper stayed behind and the host is on this build (`keeperStaysBehind`): a calm note and
 *    "Restart completely", never "Switch to this build" again and never "Could not switch builds".
 * 3. How the last swap ended, until dismissed: a failure with its reason ("Could not switch
 *    builds"), with "Try again" while the window is still behind.
 * 4. A host or keeper of another build: the builds and "Switch to this build".
 */
export function buildBar(i: BuildBarInput): BuildBar {
  const b = i.build
  if (b.mode !== 'keeper') return { kind: 'none' }
  const s = b.swap
  if (swapRunning(s)) return { kind: 'switching', text: swapProgressText(s) ?? '' }
  if (keeperStaysBehind(b)) {
    if (i.dismissed) return { kind: 'none' }
    return { kind: 'keeper_later', text: KEEPER_LATER_TEXT, ...(s?.keeperMessage ? { detail: s.keeperMessage } : {}) }
  }
  const behind = (b.sameBuild === false || b.keeperSameBuild === false) && !i.dismissed
  if (s && i.dismissedSwap !== s.startedAt && (s.phase === 'failed' || (s.phase === 'done' && s.keeperMessage))) {
    return { kind: s.phase === 'failed' ? 'failed' : 'notice', text: swapProgressText(s) ?? '', retry: behind }
  }
  if (behind) return { kind: 'other', who: b.sameBuild === false ? 'host' : 'keeper' }
  return { kind: 'none' }
}

/** The keeper's notion of one build (`BuildSource::same_build`): the same commit and build time, whatever the path */
function sameBuildKey(a: SwapBuild, b: SwapBuild): boolean {
  return a.commit.trim() === b.commit.trim() && (a.builtAt ?? '') === (b.builtAt ?? '')
}

/** True while a swap is between its start and its end */
export function swapRunning(s: SwapView | undefined): boolean {
  return !!s && s.phase !== 'done' && s.phase !== 'failed'
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.replace(/[.\s]+$/, '')
}
