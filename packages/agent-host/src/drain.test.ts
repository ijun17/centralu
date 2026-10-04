import { describe, expect, it } from 'vitest'
import { Drain, DrainCut, REFUSED_MESSAGE } from './drain.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('drain (#280 step 3)', () => {
  it('waits for a call that finishes inside the bound and hands back its own result', async () => {
    const d = new Drain()
    const call = d.track('tool quick', async () => {
      await sleep(30)
      return 'done'
    })
    const report = await d.drain(1_000)
    await expect(call).resolves.toBe('done')
    expect(report.waitedFor).toBe(1)
    expect(report.cut).toEqual([])
  })

  it('cuts a call still running at the bound with a retryable error, and does not wait for it', async () => {
    const d = new Drain()
    let release!: () => void
    const call = d.track('tool slow', () => new Promise<string>((r) => (release = () => r('late'))))
    const t0 = Date.now()
    const report = await d.drain(80)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(report.cut).toEqual(['tool slow'])
    const err = await call.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DrainCut)
    expect((err as DrainCut).retryable).toBe(true)
    expect((err as DrainCut).message).toContain('0.1s')
    // The work finishing later changes nothing for the caller that was already answered
    release()
    await sleep(0)
    expect(d.running).toBe(0)
  })

  it('refuses a call that arrives once the drain has begun', async () => {
    const d = new Drain()
    await d.drain(10)
    let ran = false
    const err = await d
      .track('rpc late', async () => {
        ran = true
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DrainCut)
    expect((err as Error).message).toBe(REFUSED_MESSAGE)
    expect(ran).toBe(false)
  })

  it('passes a failure through as the call’s own failure, not as a cut', async () => {
    const d = new Drain()
    const err = await d.track('rpc failing', async () => Promise.reject(new Error('boom'))).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(DrainCut)
    expect((err as Error).message).toBe('boom')
    expect(d.running).toBe(0)
  })

  it('returns at once when nothing is running', async () => {
    const report = await new Drain().drain(10_000)
    expect(report).toEqual({ waitedFor: 0, cut: [], ms: 0 })
  })
})
