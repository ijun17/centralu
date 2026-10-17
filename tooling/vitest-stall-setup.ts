import { relative } from 'node:path'
import { afterEach, expect } from 'vitest'
import { STALL_FAIL_MS, STALL_REPORT_MS, StallWatch, stallMessage } from './vitest-stall-watch.js'

/*
 * The stall watch (tooling/vitest-stall-watch.ts, #368), one per test file. Every clock, timer and
 * console it uses is taken here, before a test can fake or spy on them (`vi.useFakeTimers`,
 * `vi.spyOn(console, 'error')`), so a test's own fakes neither stop the watch nor see its reports.
 */
const realSetInterval = globalThis.setInterval
const hrtime = process.hrtime.bigint.bind(process.hrtime)
const writeError = console.error.bind(console)
const EVERY_MS = 1_000
// Lower bounds for tooling/vitest-stall-watch.test.ts, which runs a probe that holds its loop for a second or two
const bound = (name: string, fallback: number) => Number(process.env[name]) || fallback

const watch = new StallWatch({
  now: () => Number(hrtime() / 1_000_000n),
  where: () => {
    const { currentTestName, testPath } = expect.getState()
    const file = testPath ? relative(process.cwd(), testPath) : 'a test file'
    return currentTestName ? `"${currentTestName}" (${file})` : `${file} while it was collected`
  },
  everyMs: EVERY_MS,
  reportMs: bound('CC_STALL_REPORT_MS', STALL_REPORT_MS),
  failMs: bound('CC_STALL_FAIL_MS', STALL_FAIL_MS),
  report: (s) => writeError(`[stall] ${stallMessage(s)}`),
})
realSetInterval(() => watch.tick(), EVERY_MS).unref()

afterEach(() => {
  const stall = watch.take()
  if (stall) throw new Error(stallMessage(stall))
})
