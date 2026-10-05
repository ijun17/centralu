import { describe, expect, it } from 'vitest'
import {
  COMPLETELY_STOPS,
  KEEPER_LATER_TEXT,
  RESTART_COMPLETELY_LOSES,
  autoSwitch,
  buildBar,
  keeperStaysBehind,
  swapProgressText,
  swapRunning,
  switchPlan,
  type AutoSwitchInput,
  type BuildBarInput,
  type SwapView,
} from './switch-plan.js'

describe('what switching builds costs (#280 step 3)', () => {
  it('switches without asking when nothing is running', () => {
    expect(switchPlan({ keepsAgents: false, busy: false }).confirm).toBe(false)
    expect(switchPlan({ keepsAgents: true, busy: false }).confirm).toBe(false)
  })

  it('asks when something is running, or when it cannot tell', () => {
    expect(switchPlan({ keepsAgents: true, busy: true }).confirm).toBe(true)
    expect(switchPlan({}).confirm).toBe(true)
  })

  it('a host that keeps agents only puts a slow in-process tool call at risk', () => {
    const { loses } = switchPlan({ keepsAgents: true, busy: true })
    expect(loses).toContain('Agents keep running')
    expect(loses).toContain('10 seconds')
    expect(loses).not.toContain('turns stop')
  })

  it('moving only the keeper asks nothing and loses nothing (#280 step 4)', () => {
    const plan = switchPlan({ keepsAgents: true, busy: true, sameBuild: true, keeperSameBuild: false })
    expect(plan.confirm).toBe(false)
    expect(plan.loses).toContain('Nothing stops')
    // A host of another build still costs what a host swap costs
    expect(switchPlan({ keepsAgents: true, busy: true, sameBuild: false, keeperSameBuild: false }).confirm).toBe(true)
  })

  it('a host that cannot hand agents over yet says turns stop, rather than pretending they survive', () => {
    const { loses } = switchPlan({ keepsAgents: false, busy: true })
    expect(loses).toContain('running turns stop')
    expect(loses).toContain('10 seconds')
    // Unknown is treated as the host that cannot
    expect(switchPlan({ busy: true }).loses).toBe(loses)
  })
})

describe('a swap’s progress in the bar (#280 step 3)', () => {
  const swap = (over: Partial<SwapView>): SwapView => ({ phase: 'starting', target: { commit: 'b' }, startedAt: 1, ...over })

  it('names each phase while it runs and nothing once it is done', () => {
    expect(swapProgressText(swap({ phase: 'draining' }))).toContain('finish')
    expect(swapProgressText(swap({ phase: 'activating' }))).toContain('Reconnecting')
    expect(swapProgressText(swap({ phase: 'done' }))).toBeNull()
    expect(swapRunning(swap({ phase: 'standby' }))).toBe(true)
    expect(swapRunning(swap({ phase: 'failed' }))).toBe(false)
  })

  it('names the keeper moving, and says so when it stayed behind (#280 step 4)', () => {
    expect(swapProgressText(swap({ phase: 'handing_over' }))).toContain('background keeper')
    expect(swapRunning(swap({ phase: 'handing_over' }))).toBe(true)
    expect(swapProgressText(swap({ phase: 'done', keeperMessage: 'the new keeper did not start: x\ny' }))).toBe(
      'Switched builds, but the background keeper stays on the previous build: the new keeper did not start: x.',
    )
  })

  it('a failure says why, on one line, and which build is serving now', () => {
    const before = swapProgressText(swap({ phase: 'failed', message: 'the new build did not pass its start check: it exited\nline 2' }))
    expect(before).toBe(
      'Could not switch builds: the new build did not pass its start check: it exited. The running build was not touched and is still serving.',
    )
    const after = swapProgressText(swap({ phase: 'failed', message: 'x', rolledBack: true }))
    expect(after).toContain('previous build was started again')
  })
})

/** The window "Apply now" started, or the automatic mode, switching by itself (#352) */
describe('switching by itself after an update (#352)', () => {
  const quiet: AutoSwitchInput = {
    build: { keepsAgents: true, busy: false, sameBuild: false, keeperSameBuild: false, relaunched: true },
    autoApply: false,
    tried: false,
    dismissed: false,
  }

  it('the window "Apply now" started switches without a click when nothing can be lost', () => {
    expect(autoSwitch(quiet)).toBe('switch')
  })

  it('asks at once when something can be lost, since the person just pressed "Apply now"', () => {
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, busy: true } })).toBe('ask')
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, busy: undefined } })).toBe('ask')
  })

  it('a keeper alone behind moves without a question, busy or not', () => {
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, busy: true, sameBuild: true } })).toBe('switch')
  })

  it('the automatic mode switches when idle and waits while busy, never asking', () => {
    const auto = { ...quiet, autoApply: true, build: { ...quiet.build, relaunched: false } }
    expect(autoSwitch(auto)).toBe('switch')
    expect(autoSwitch({ ...auto, build: { ...auto.build, busy: true } })).toBe('wait')
  })

  it('a window opened by hand, with the automatic mode off, leaves it to the bar', () => {
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, relaunched: false } })).toBe('none')
  })

  it('never twice, never after "Not now", never during a swap, never when nothing is behind', () => {
    expect(autoSwitch({ ...quiet, tried: true })).toBe('none')
    expect(autoSwitch({ ...quiet, dismissed: true })).toBe('none')
    const swap: SwapView = { phase: 'draining', target: { commit: 'b' }, startedAt: 1 }
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, swap } })).toBe('none')
    expect(autoSwitch({ ...quiet, build: { ...quiet.build, sameBuild: true, keeperSameBuild: true } })).toBe('none')
  })
})

/**
 * A keeper of an older build that cannot hand itself over (#387): beta.10's keeper fails with
 * "Message too long" on macOS, and the fix lives in the sending keeper, which an update does not
 * replace. The host swap goes ahead under it; the window must not keep offering a switch that can
 * only fail again, nor call the second try a failure.
 */
describe('a keeper that stays on its build while the host runs this one (#387)', () => {
  const app = { commit: '9e77999e', builtAt: '2026-10-05T10:00:00Z' }
  const tooLong = 'could not pass the state on: Message too long (os error 40)'
  /** What beta.10's keeper reports when the host already runs this build (the second click) */
  const secondTry: SwapView = {
    phase: 'failed',
    target: app,
    from: app,
    message: `could not hand over to the new build's keeper: ${tooLong}`,
    keeperMessage: tooLong,
    startedAt: 2,
  }
  /** ...and on the first click, when the host swap went ahead under it */
  const firstTry: SwapView = { phase: 'done', target: app, from: { commit: 'daf4ecf5' }, keeperMessage: tooLong, startedAt: 1 }
  const behindKeeper = { mode: 'keeper' as const, app, sameBuild: true, keeperSameBuild: false }
  const input = (swap: SwapView | undefined, over: Partial<BuildBarInput> = {}): BuildBarInput => ({
    build: { ...behindKeeper, ...(swap ? { swap } : {}) },
    dismissed: false,
    dismissedSwap: null,
    ...over,
  })

  it('reads the host on this build with the keeper left behind as running the new version, not as a failure', () => {
    for (const swap of [secondTry, firstTry]) {
      expect(keeperStaysBehind({ ...behindKeeper, swap })).toBe(true)
      const bar = buildBar(input(swap))
      expect(bar).toEqual({ kind: 'keeper_later', text: KEEPER_LATER_TEXT, detail: tooLong })
      expect(JSON.stringify(bar)).not.toContain('Could not switch builds')
    }
  })

  it('a restart is what moves the keeper, and it says plainly what stops', () => {
    expect(KEEPER_LATER_TEXT).toContain('next time it restarts')
    expect(RESTART_COMPLETELY_LOSES).toContain(COMPLETELY_STOPS)
    expect(COMPLETELY_STOPS).toBe('Also stops agents, terminals and running commands.')
  })

  it('does not switch by itself again either', () => {
    const build = { ...behindKeeper, keepsAgents: true, busy: false, relaunched: true, swap: secondTry }
    expect(autoSwitch({ build, autoApply: true, tried: false, dismissed: false })).toBe('none')
  })

  it('only for this build, only once the host is on it, and only when the keeper said why it stayed', () => {
    // The swap was to another window's build
    expect(keeperStaysBehind({ ...behindKeeper, swap: { ...secondTry, target: { commit: 'other' } } })).toBe(false)
    expect(keeperStaysBehind({ ...behindKeeper, swap: { ...secondTry, target: { ...app, builtAt: 'later' } } })).toBe(false)
    // The host did not reach this build: that is a real failure
    expect(keeperStaysBehind({ ...behindKeeper, sameBuild: false, swap: secondTry })).toBe(false)
    // Nothing went wrong with the keeper, or it is on this build already
    const { keeperMessage: _, ...noReason } = secondTry
    expect(keeperStaysBehind({ ...behindKeeper, swap: noReason })).toBe(false)
    expect(keeperStaysBehind({ ...behindKeeper, keeperSameBuild: true, swap: secondTry })).toBe(false)
    // Still running
    expect(keeperStaysBehind({ ...behindKeeper, swap: { ...secondTry, phase: 'handing_over' } })).toBe(false)
  })

  it('a keeper behind that has not tried yet is still offered the switch, which stops nothing', () => {
    expect(buildBar(input(undefined))).toEqual({ kind: 'other', who: 'keeper' })
  })

  it('"Dismiss" hides the note until the window is no longer behind', () => {
    expect(buildBar(input(secondTry, { dismissed: true }))).toEqual({ kind: 'none' })
  })
})

describe('the build bar otherwise (#280)', () => {
  const app = { commit: 'new' }
  const host = { mode: 'keeper' as const, app, sameBuild: false, keeperSameBuild: false }
  const input = (build: BuildBarInput['build'], over: Partial<BuildBarInput> = {}): BuildBarInput => ({
    build,
    dismissed: false,
    dismissedSwap: null,
    ...over,
  })

  it('a real failure says "Could not switch builds" with its reason and offers to try again, as before', () => {
    const swap: SwapView = { phase: 'failed', target: app, message: 'the new build did not pass its start check: it exited', startedAt: 3 }
    expect(buildBar(input({ ...host, swap }))).toEqual({
      kind: 'failed',
      text: 'Could not switch builds: the new build did not pass its start check: it exited. The running build was not touched and is still serving.',
      retry: true,
    })
    // The keeper stayed too, but the host did not reach this build either: still a failure
    expect(buildBar(input({ ...host, swap: { ...swap, keeperMessage: 'x' } })).kind).toBe('failed')
    // Dismissed: the switch is offered again, without the error
    expect(buildBar(input({ ...host, swap }, { dismissedSwap: 3 }))).toEqual({ kind: 'other', who: 'host' })
  })

  it('shows a running swap, nothing in direct mode, and nothing once everything is on this build', () => {
    expect(buildBar(input({ ...host, swap: { phase: 'draining', target: app, startedAt: 1 } })).kind).toBe('switching')
    expect(buildBar(input({ ...host, mode: 'direct' }))).toEqual({ kind: 'none' })
    expect(buildBar(input({ mode: 'keeper', app, sameBuild: true, keeperSameBuild: true }))).toEqual({ kind: 'none' })
    expect(buildBar(input(host, { dismissed: true }))).toEqual({ kind: 'none' })
  })
})
