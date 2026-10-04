import { describe, expect, it } from 'vitest'
import { swapProgressText, swapRunning, switchPlan, type SwapView } from './switch-plan.js'

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

  it('a failure says why, on one line, and which build is serving now', () => {
    const before = swapProgressText(swap({ phase: 'failed', message: 'the new build did not pass its start check: it exited\nline 2' }))
    expect(before).toBe(
      'Could not switch builds: the new build did not pass its start check: it exited. The running build was not touched and is still serving.',
    )
    const after = swapProgressText(swap({ phase: 'failed', message: 'x', rolledBack: true }))
    expect(after).toContain('previous build was started again')
  })
})
