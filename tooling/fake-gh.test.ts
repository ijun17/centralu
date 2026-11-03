import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'

const ANSWER = String.raw`
if (args[0] === 'echo') { st.seen = [...(st.seen ?? []), stdin]; save(); process.stdout.write(JSON.stringify(st)) }
// Rewrites a large state again and again, as a polling app's gh calls do while the test reads it
if (args[0] === 'spin') for (let i = 0; i < 200; i++) { st.n = i; st.pad = 'x'.repeat(200_000); save() }
`

let root = ''
let gh: FakeGh
afterEach(() => rmFakeDir(root))

function make() {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-gh-')))
  gh = fakeGh(root, ANSWER)
  return gh
}
const run = (args: string[], input?: string) =>
  spawnSync('gh', args, { env: gh.env(), input, encoding: 'utf8', windowsHide: true })

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
   * The fake rewrites the state in place, so a read can find it half written. The shared reader tries again; the
   * queue test's reader did, and the other readers did not (#845).
   */
  it('reads the state whole while the fake is rewriting it', async () => {
    make()
    gh.setState({ n: -1 })
    const spinner = spawn('gh', ['spin'], { env: gh.env(), stdio: 'ignore', windowsHide: true })
    const done = new Promise((r) => spinner.once('exit', r))
    let ended = false
    void done.then(() => (ended = true))
    const torn: string[] = []
    let reads = 0
    while (!ended) {
      try {
        gh.state()
        reads++
      } catch (e) {
        torn.push((e as Error).message)
      }
      await new Promise((r) => setImmediate(r))
    }
    expect(torn).toEqual([])
    expect(reads).toBeGreaterThan(0)
    expect(gh.state().n).toBe(199)
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
