import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@cc/protocol'
import { applyOffer, autoApplyDecision, type AutoApplyInput } from './apply-update.js'

/**
 * Applying an installed update (#352): what the update line offers, and when the automatic mode
 * relaunches by itself.
 */
const installed: UpdateStatus = {
  current: '0.1.0-beta.10',
  latest: '0.1.0-beta.11',
  newer: true,
  auto: true,
  autoApply: true,
  phase: 'restart_required',
  error: null,
  checkedAt: 1,
}
const OLD_WINDOW = '0.1.0-beta.10'
const ready = { ready: true }

describe('applyOffer', () => {
  it('offers "Apply now" when a relaunch starts the installed build', () => {
    expect(applyOffer(installed, OLD_WINDOW, ready)).toEqual({ kind: 'apply' })
  })

  it('keeps "restart" where the platform cannot relaunch, or the bundle was not replaced, with the reason', () => {
    expect(applyOffer(installed, OLD_WINDOW, undefined)).toEqual({ kind: 'restart' })
    expect(applyOffer(installed, OLD_WINDOW, { ready: false, reason: 'did not replace' })).toEqual({ kind: 'restart', reason: 'did not replace' })
  })

  /**
   * The relaunched window is the new build while the host is still the old one, which still says
   * `restart_required`. Offering a relaunch there would relaunch into the same build forever.
   */
  it('offers nothing to a window that already runs the installed version', () => {
    expect(applyOffer(installed, '0.1.0-beta.11', ready)).toEqual({ kind: 'current' })
  })
})

describe('autoApplyDecision', () => {
  const idle: AutoApplyInput = { update: installed, windowVersion: OLD_WINDOW, relaunch: ready, busy: false, typing: false, tried: false }

  it('relaunches once installed, idle, and nobody typing', () => {
    expect(autoApplyDecision(idle)).toEqual({ apply: true })
  })

  it('never applies with the setting off', () => {
    expect(autoApplyDecision({ ...idle, update: { ...installed, autoApply: false } }).apply).toBe(false)
  })

  it('waits for the install to finish', () => {
    expect(autoApplyDecision({ ...idle, update: { ...installed, phase: 'updating' } }).apply).toBe(false)
  })

  /** A session working, an approval or a question waiting, a terminal or a command: never then */
  it('never applies while anything is running, and unknown counts as running', () => {
    expect(autoApplyDecision({ ...idle, busy: true })).toEqual({ apply: false, waitingFor: 'something is running' })
    expect(autoApplyDecision({ ...idle, busy: null })).toEqual({ apply: false, waitingFor: 'something is running' })
  })

  it('never relaunches under someone typing', () => {
    expect(autoApplyDecision({ ...idle, typing: true })).toEqual({ apply: false, waitingFor: 'you are typing' })
  })

  it('does not loop: not from the relaunched window, not twice from one window, not where a relaunch changes nothing', () => {
    expect(autoApplyDecision({ ...idle, windowVersion: '0.1.0-beta.11' }).apply).toBe(false)
    expect(autoApplyDecision({ ...idle, tried: true }).apply).toBe(false)
    expect(autoApplyDecision({ ...idle, relaunch: { ready: false } }).apply).toBe(false)
    expect(autoApplyDecision({ ...idle, relaunch: undefined }).apply).toBe(false)
  })
})
