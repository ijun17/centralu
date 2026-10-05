import { describe, expect, it } from 'vitest'
import { autoSwitch, swapProgressText, swapRunning, switchPlan, type AutoSwitchInput, type SwapView } from './switch-plan.js'

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
