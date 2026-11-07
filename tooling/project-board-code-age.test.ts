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
  /** A checkout holding the app, committed once: where the board app's code is read from */
  const checkout = () => {
    const top = join(root, 'code-checkout')
    const app = join(top, '.centralu', 'apps', 'project-board')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'queue.mjs'), '// old\n')
    g(top, 'init', '-q')
    g(top, 'add', '-A')
    g(top, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'old board')
    return { app, head: g(top, 'rev-parse', 'HEAD') }
  }
  const drive = (drives: boolean) => {
    mkdirSync(dataDirOnDisk(), { recursive: true })
    writeFileSync(join(dataDirOnDisk(), 'queue-driver.json'), JSON.stringify({ drive: drives }))
  }
  /** main is `behind` commits ahead of the checkout, changing `files` */
  const start = (behind: number, files: string[]) => {
    const { app, head } = checkout()
    const key = `${head}...main`
    runtime(ghState({ compareAhead: { [key]: behind }, compareFiles: { [key]: files } }), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: app, PROJECT_BOARD_CODE_CHECK_MS: '0' }, gitWrapper(fake.bin))
    return head
  }

  it('shows how many commits behind and warns when this instance drives the queue, with board files changed since', async () => {
    drive(true)
    const head = start(32, ['docs/a.md', '.centralu/apps/project-board/main-guard.mjs'])
    const told = await call('merge_queue')
    expect(told.text).toContain(`Board code: 32 commits behind main (running ${head.slice(0, 7)}), and the board app changed since.`)
    expect(told.text).toContain('Warning: this instance drives the merge queue with board code 32 commits behind main')
    expect(told.data.code).toMatchObject({ head, behind: 32, appChanged: true, warning: expect.stringContaining('git pull --ff-only') })
  })

  it('warns for a queue with an item in it, with no driver file, and for the main guard that drives', async () => {
    const { app, head } = checkout()
    const key = `${head}...main`
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'waiting', title: 'feat(ui): change 81', queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reruns: {} }])
    runtime(ghState({ compareAhead: { [key]: 3 }, compareFiles: { [key]: ['.centralu/apps/project-board/queue.mjs'] } }), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: app, PROJECT_BOARD_CODE_CHECK_MS: '0', PROJECT_BOARD_QUEUE_GUARD: 'on' }, gitWrapper(fake.bin))
    const told = await call('merge_queue')
    expect(told.text).toContain('Warning: this instance drives the merge queue and the main guard with board code 3 commits behind main')
  })

  it('shows the count without a warning when none of the commits touch the board app, or the instance does not drive', async () => {
    drive(true)
    start(5, ['docs/a.md', 'packages/ui/src/b.ts'])
    const told = await call('merge_queue')
    expect(told.text).toContain('Board code: 5 commits behind main')
    expect(told.text).toContain('none of them in the board app')
    expect(told.text).not.toContain('Warning: this instance drives')
    expect(told.data.code).toMatchObject({ behind: 5, appChanged: false, warning: null })
  })

  it('counts a changed-files list GitHub may have cut as a change to the board app', async () => {
    drive(true)
    start(400, Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`))
    const told = await call('merge_queue')
    expect(told.data.code).toMatchObject({ behind: 400, appChanged: true })
    expect(told.text).toContain('Warning: this instance drives the merge queue')
  })

  it('does not warn an instance that does not drive: a person who set it passive, with nothing queued', async () => {
    drive(false)
    start(32, ['.centralu/apps/project-board/main-guard.mjs'])
    const told = await call('merge_queue')
    expect(told.text).toContain('Board code: 32 commits behind main')
    expect(told.text).not.toContain('Warning: this instance drives')
    expect(told.data.code.warning).toBeNull()
  })

  it('says nothing when the code is at main or is not in a git checkout, and says it once main moves', async () => {
    drive(true)
    const head = start(0, [])
    let told = await call('merge_queue')
    expect(told.text).not.toContain('Board code')
    expect(told.data.code).toBeUndefined()
    // Main moves: said at the next look, the answer is not kept for ever
    patchGh((st) => (st.compareAhead[`${head}...main`] = 7))
    told = await call('merge_queue')
    expect(told.text).toContain('Board code: 7 commits behind main')
    // Not a git checkout
    mkdirSync(join(root, 'not-git'), { recursive: true })
    runtime(ghState({}), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: join(root, 'not-git'), PROJECT_BOARD_CODE_CHECK_MS: '0' }, gitWrapper(fake.bin))
    told = await call('merge_queue')
    expect(told.text).not.toContain('Board code')
  })
})
