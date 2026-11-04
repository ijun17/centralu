import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'
import { removeTree } from '../packages/agent-host/src/temp-dir.test-helpers.js'

const { readState } = createRequire(import.meta.url)('./fake-gh-state.cjs') as { readState: (path: string, options?: { pause?: () => void; now?: () => number }) => unknown }

const ANSWER = String.raw`
if (args[0] === 'echo') { st.seen = [...(st.seen ?? []), stdin]; save(); process.stdout.write(JSON.stringify(st)) }
// Rewrites a large state again and again, as a polling app's gh calls do while the test reads it
if (args[0] === 'spin') for (let i = 0; i < 200; i++) { st.n = i; st.pad = 'x'.repeat(200_000); save() }
`

let root = ''
let gh: FakeGh
afterEach(() => removeTree(root))

function make() {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-gh-')))
  gh = fakeGh(root, ANSWER)
  return gh
}
const run = (args: string[], input?: string) =>
  spawnSync('gh', args, { env: gh.env(), input, encoding: 'utf8', windowsHide: true })

/** Reads the state with `read` in a loop while a fake gh rewrites it 200 times; answers the reads that threw and the last number it wrote */
async function readWhileSpinning(read: (statePath: string) => unknown) {
  const spinner = spawn('gh', ['spin'], { env: gh.env(), stdio: 'ignore', windowsHide: true })
  const done = new Promise((r) => spinner.once('exit', r))
  let ended = false
  void done.then(() => (ended = true))
  const torn: string[] = []
  let reads = 0
  while (!ended) {
    try {
      read(gh.statePath)
      reads++
    } catch (e) {
      torn.push((e as Error).message)
    }
    await new Promise((r) => setImmediate(r))
  }
  return { torn, reads, ended: gh.state<{ n: number }>().n }
}

describe('the shared fake gh', { timeout: 30_000 * SLOW }, () => {
  it('is the gh its PATH finds, logs each call with what --input sent, and answers from the state the test wrote', () => {
    make()
    gh.setState({ seen: ['from the test'] })
    const r = run(['echo', '--input', '-'], '{"body":"hi"}')
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ seen: ['from the test', '{"body":"hi"}'] })
    expect(run(['echo']).status).toBe(0)
    expect(gh.calls()).toEqual([
      { args: ['echo', '--input', '-'], stdin: '{"body":"hi"}' },
      { args: ['echo'], stdin: null },
    ])
    expect(gh.state().seen).toEqual(['from the test', '{"body":"hi"}', null])
    gh.patchState((s) => (s.seen = []))
    expect(gh.state()).toEqual({ seen: [] })
    gh.clearCalls()
    expect(gh.calls()).toEqual([])
  })

  /*
   * The fake rewrites the state again and again while the test reads it. Where a file can be replaced under a reader, the
   * fake writes a whole file and renames it into place, so a read that does not try again never finds it half written. It
   * wrote in place before, and a reader that tried again (50 times, 20 ms apart) was still beaten by a loaded CI runner: the
   * main guard reverted an innocent pull request for the failure (#1496).
   */
  it.skipIf(process.platform === 'win32')('never shows the state half written while the fake is rewriting it', async () => {
    make()
    gh.setState({ n: -1 })
    const { ended, reads, torn } = await readWhileSpinning((statePath) => JSON.parse(readFileSync(statePath, 'utf8')))
    expect(torn).toEqual([])
    expect(reads).toBeGreaterThan(0)
    expect(ended).toBe(199)
  })

  /* Windows refuses to replace a file another process has open, so there the state is written in place and the read waits for it */
  it('reads the state whole while the fake is rewriting it', async () => {
    make()
    gh.setState({ n: -1 })
    const { ended, reads, torn } = await readWhileSpinning(() => gh.state())
    expect(torn).toEqual([])
    expect(reads).toBeGreaterThan(0)
    expect(ended).toBe(199)
  })

  // The read tries again for a budget of seconds, not a count of tries (50 tries 20 ms apart ran out on a loaded runner, #1496). The wait
  // between tries and the clock are the test's, so nothing here waits for time to pass: the writer finishes on the 200th try, four
  // seconds of 20 ms pauses, and the budget is spent when the clock says so
  it('waits for a state that is half written through more tries than before, and gives up when its budget is spent', () => {
    make()
    writeFileSync(gh.statePath, '{"n": 1, "pad": "x')
    let tries = 0
    expect(readState(gh.statePath, { pause: () => { if (++tries === 200) writeFileSync(gh.statePath, JSON.stringify({ n: 7 })) } })).toEqual({ n: 7 })
    expect(tries).toBe(200)
    writeFileSync(gh.statePath, '{"n": 1, "pad": "x')
    let clock = 0
    expect(() => readState(gh.statePath, { pause: () => (clock += 1000), now: () => clock })).toThrow(SyntaxError)
    expect(clock).toBe(6000)
    // A state that is not there is no half written one: it is an error at once
    expect(() => readState(join(root, 'none.json'), { pause: () => expect.unreachable('it waited for a file that is not there') })).toThrow(/ENOENT/)
  })

  /*
   * A test that ends its app while the app is starting a gh leaves that gh suspended for ever on Windows (the parent was
   * gone before it was resumed), and nothing collects it: five stayed on a machine for two days. The sweep ends what still
   * runs a script of this process's fakes, and nothing else.
   */
  it.runIf(process.platform === 'win32')('ends a process still running from the folder of a fake gh, and leaves the others', async () => {
    make()
    const idle = join(gh.bin, 'idle.cjs')
    writeFileSync(idle, 'setInterval(() => {}, 1000)')
    const mine = spawn(process.execPath, [idle], { stdio: 'ignore', windowsHide: true })
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(endLeftoverFakes()).toContain(mine.pid)
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(mine.pid!)).toBe(false)
      expect(alive(other.pid!)).toBe(true)
    } finally {
      other.kill()
      mine.kill()
    }
  })
})
