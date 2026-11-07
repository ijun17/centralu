import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitWrapper } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { g } from './git-fixture.test-helpers.js'
import { SLOW } from './test-timing.js'
import { R, fake, ghState, IDLE_SERVER, root, runtime, call, patchGh, seedQueue } from './project-board-queue.test-helpers.js'

// #2121 (2026-11-06): two board instances ran old code at once, one 252 commits behind main with a main guard older than the rerun-before-blame
// rule, and nothing said so. merge_queue now says how far the board's own code is behind main and warns when it drives on old code.
describe("merge_queue says how far the board's own code is behind main (#2121)", { timeout: 60_000 * SLOW }, () => {
  const dataDirOnDisk = () => join(root, 'data', 'app-data', 'p1', 'project-board')
  const top = () => join(root, 'code-checkout')
  const commit = (message: string) => {
    g(top(), 'add', '-A')
    g(top(), '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message, '--allow-empty')
    return g(top(), 'rev-parse', 'HEAD')
  }
  /** A checkout holding the app, committed once: where the board app's code is read from */
  const checkout = () => {
    const app = join(top(), '.centralu', 'apps', 'project-board')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'queue.mjs'), '// old\n')
    g(top(), 'init', '-q')
    return { app, head: commit('old board') }
  }
  const drive = (drives: boolean) => {
    mkdirSync(dataDirOnDisk(), { recursive: true })
    writeFileSync(join(dataDirOnDisk(), 'queue-driver.json'), JSON.stringify({ drive: drives }))
  }
  const waiting = () =>
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'waiting', title: 'feat(ui): change 81', queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reruns: {} }])
  /** main is `behind` commits ahead of the checkout, changing `files` */
  const start = (behind: number, files: string[], env: Record<string, string> = {}) => {
    const { app, head } = checkout()
    const key = `${head}...main`
    runtime(ghState({ compareAhead: { [key]: behind }, compareFiles: { [key]: files } }), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: app, PROJECT_BOARD_CODE_CHECK_MS: '0', ...env }, gitWrapper(fake.bin))
    return { head, key }
  }
  const BOARD = ['docs/a.md', '.centralu/apps/project-board/main-guard.mjs']

  it('shows how many commits behind, and warns a queue that has work, with board files changed since', async () => {
    waiting()
    const { head } = start(32, BOARD)
    const told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).toContain(`Board code: 32 commits behind main (running ${head.slice(0, 7)}), and the board app changed since.`)
    expect(told.text).toContain('Warning: this instance drives the merge queue with board code 32 commits behind main')
    expect(told.data.code).toMatchObject({ head, behind: 32, appChanged: true, warning: expect.stringContaining('git pull --ff-only') })
  })

  it('warns the main guard that drives, and says how to stop it; an instance told not to drive is not warned for it', async () => {
    drive(true)
    start(3, ['.centralu/apps/project-board/queue.mjs'], { PROJECT_BOARD_QUEUE_GUARD: 'on' })
    let told = await call('merge_queue')
    expect(told.text).toContain('Warning: this instance drives the main guard with board code 3 commits behind main')
    expect(told.text).toContain('queue-driver.json {"drive": false}')
    drive(false)
    told = await call('merge_queue')
    expect(told.text).toContain('Board code: 3 commits behind main')
    expect(told.text).not.toContain('Warning')
  })

  it('shows the count without a warning when none of the commits touch the board app, or nothing here drives', async () => {
    waiting()
    start(5, ['docs/a.md', 'packages/ui/src/b.ts'])
    const told = await call('merge_queue')
    expect(told.text).toContain('Board code: 5 commits behind main')
    expect(told.text).toContain('none of them in the board app')
    expect(told.text).not.toContain('Warning')
    expect(told.data.code).toMatchObject({ behind: 5, appChanged: false, warning: null })
  })

  it('does not warn when the board app changed but nothing waits in the queue and the guard is off', async () => {
    start(5, BOARD)
    const told = await call('merge_queue')
    expect(told.text).toContain('and the board app changed since')
    expect(told.text).not.toContain('Warning')
  })

  it('counts a changed-files list GitHub may have cut as a change to the board app', async () => {
    waiting()
    start(400, Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`))
    const told = await call('merge_queue')
    expect(told.data.code).toMatchObject({ behind: 400, appChanged: true })
    expect(told.text).toContain('Warning: this instance drives the merge queue')
  })

  it('says nothing when the code is at main, not in a git checkout, unknown to GitHub, or GitHub cannot be asked, and says it once main moves', async () => {
    waiting()
    const { key } = start(0, [])
    let told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
    expect(told.data.code).toBeUndefined()
    // Main moves: said at the next look
    patchGh((st) => (st.compareAhead[key] = 7))
    told = await call('merge_queue')
    expect(told.text).toContain('Board code: 7 commits behind main')
    // GitHub cannot be asked: nothing is said, and merge_queue still answers
    patchGh((st) => (st.compareError = 'HTTP 500'))
    told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
    patchGh((st) => delete st.compareError)
    // A commit GitHub does not know: no count
    patchGh((st) => delete st.compareAhead[key])
    told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
    // Code that is not in a git checkout (an installed copy): no count either
    mkdirSync(join(root, 'not-git'), { recursive: true })
    runtime(ghState({}), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: join(root, 'not-git'), PROJECT_BOARD_CODE_CHECK_MS: '0' }, gitWrapper(fake.bin))
    told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
  })

  it('compares the code the app started with, and says when the checkout has been pulled since without a restart', async () => {
    waiting()
    const { head } = start(2, BOARD)
    let told = await call('merge_queue')
    expect(told.text).toContain(`running ${head.slice(0, 7)}`)
    // Someone pulls: the files change, the running code does not
    const pulled = commit('pulled')
    told = await call('merge_queue')
    expect(told.text).toContain(`The checkout is at ${pulled.slice(0, 7)} now, not at ${head.slice(0, 7)} as the app started`)
    expect(told.text).toContain(`running ${head.slice(0, 7)}`)
  })

  it('asks GitHub once in a while, not at every merge_queue', async () => {
    waiting()
    start(4, BOARD, { PROJECT_BOARD_CODE_CHECK_MS: '3600000' })
    await call('merge_queue')
    const asked = () => fake.calls().filter((c) => c.args.join(' ').includes('/compare/')).length
    const first = asked()
    expect(first).toBeGreaterThan(0)
    await call('merge_queue')
    await call('merge_queue')
    expect(asked()).toBe(first)
  })
})
