import { expect, it } from 'vitest'

/* Run only by tooling/fixtures/listed/outer.test.ts, in the vitest it starts (CC_LISTED_PROBE=1) */
it.runIf(process.env.CC_LISTED_PROBE === '1')('runs in the vitest a listed test started', () => {
  expect(1).toBe(1)
})
