import { it, vi } from 'vitest'

/*
 * Run only by tooling/vitest-stall-watch.test.ts, in a vitest of its own with low bounds (CC_STALL_PROBE=1): each
 * test holds its worker's event loop for a few seconds, as a long synchronous step does.
 */
const probe = process.env.CC_STALL_PROBE === '1'
// Taken before a test fakes the clocks: fake timers stop performance.now and Date
const clock = process.hrtime.bigint.bind(process.hrtime)
const hold = (ms: number) => {
  const end = clock() + BigInt(ms) * 1_000_000n
  while (clock() < end) {
    // held
  }
}

it.runIf(probe)('holds the loop', () => hold(3_000))

it.runIf(probe)('holds the loop with its timers faked', () => {
  vi.useFakeTimers()
  try {
    hold(3_000)
  } finally {
    vi.useRealTimers()
  }
})

it.runIf(probe)('gives the loop a turn between the steps', async () => {
  for (let i = 0; i < 6; i++) {
    hold(500)
    await new Promise((r) => setImmediate(r))
  }
})
