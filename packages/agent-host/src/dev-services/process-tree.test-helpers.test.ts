import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
import { alive, cleanUp, settle } from './process-tree.test-helpers.js'

/**
 * `cleanUp` after a test (#1244). A pid in its list that is there after a test that passed is not the test's own any
 * more: every such test saw its tree gone, so the number belongs to whoever Windows gave it to since. A live process
 * of this test's own stands in for that someone.
 */
describe("cleanUp, the tree tests' cleanup", () => {
  let child: ChildProcess | undefined
  afterEach(async () => {
    child?.kill()
    if (child?.pid) await settle(() => alive(child!.pid!), (a) => !a, 10_000)
    child = undefined
  })
  const someoneElse = async (): Promise<number> => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const pid = child.pid!
    expect(await settle(() => alive(pid), Boolean, 10_000)).toBe(true)
    return pid
  }
  const after = (state: 'pass' | 'fail') => ({ task: { result: { state } } }) as unknown as TestContext

  it('leaves a live pid in its list alone after a test that passed', async () => {
    const pid = await someoneElse()
    await cleanUp([pid], after('pass'))
    // Waits up to 1 s for it to be gone, and it must not be: TerminateProcess and SIGTERM both end a Node that only
    // waits on a timer at once, so a kill would have landed by then
    expect(await settle(() => alive(pid), (a) => !a, 1_000)).toBe(true)
  })

  it('ends what a failed test left running and waits for it to be gone', async () => {
    const pid = await someoneElse()
    await cleanUp([pid], after('fail'))
    expect(alive(pid)).toBe(false)
  })
})
