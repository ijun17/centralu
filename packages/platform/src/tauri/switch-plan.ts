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
 */

/** Where a build came from, as the keeper records it */
export type SwapBuild = { commit: string; version?: string; bundlePath?: string }

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

/** True while a swap is between its start and its end */
export function swapRunning(s: SwapView | undefined): boolean {
  return !!s && s.phase !== 'done' && s.phase !== 'failed'
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.replace(/[.\s]+$/, '')
}
