import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
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
})
