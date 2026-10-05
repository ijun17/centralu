import { describe, expect, it } from 'vitest'
import { StartGate } from './start-gate.js'

/** Claude starts spaced out on Windows (#353), on a clock the test moves by hand */
function clock() {
  let now = 1_000
  const slept: number[] = []
  return {
    now: () => now,
    // Callers that asked at the same moment each wait their own share; the clock is moved by `advance`
    sleep: async (ms: number) => void slept.push(ms),
    advance: (ms: number) => (now += ms),
    slept,
  }
}

describe('spacing Claude process starts (#353)', () => {
  it('starts asked for together go one gap apart, the first at once', async () => {
    const c = clock()
    const gate = new StartGate(1500, c.now, c.sleep)
    await Promise.all([gate.turn(), gate.turn(), gate.turn()])
    expect(c.slept).toEqual([1500, 3000])
  })

  it('a start after a quiet spell goes at once', async () => {
    const c = clock()
    const gate = new StartGate(1500, c.now, c.sleep)
    await gate.turn()
    c.advance(2000)
    await gate.turn()
    expect(c.slept).toEqual([])
  })

  it('a start soon after another waits only the rest of the gap', async () => {
    const c = clock()
    const gate = new StartGate(1500, c.now, c.sleep)
    await gate.turn()
    c.advance(1000)
    await gate.turn()
    expect(c.slept).toEqual([500])
  })

  it('no gap, no waiting', async () => {
    const c = clock()
    const gate = new StartGate(0, c.now, c.sleep)
    await Promise.all([gate.turn(), gate.turn()])
    expect(c.slept).toEqual([])
  })
})
