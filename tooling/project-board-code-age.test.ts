import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitWrapper } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { g } from './git-fixture.test-helpers.js'
import { SLOW } from './test-timing.js'
import { R, fake, ghState, IDLE_SERVER, root, runtime, call, patchGh, seedQueue, until } from './project-board-queue.test-helpers.js'

// #2121 (2026-11-06): two board instances ran old code at once, one 252 commits behind main with a main guard older than the rerun-before-blame
// rule, and nothing said so. merge_queue now says how far the board's own code is behind main and warns when it drives on old code.
// The answer comes from GitHub, so merge_queue never waits for it: the first call shows nothing, a later one what was learned meanwhile.
describe("merge_queue says how far the board's own code is behind main (#2121)", { timeout: 60_000 * SLOW }, () => {
  const dataDirOnDisk = () => join(root, 'data', 'app-data', 'p1', 'project-board')
  const top = () => join(root, 'code-checkout')
  const commit = (message: string) => {
    g(top(), 'add', '-A')
    g(top(), '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message, '--allow-empty')
    return g(top(), 'rev-parse', 'HEAD')
  }
  /** A checkout holding the app in `folder`, committed once: where the board app's code is read from */
  const checkout = (folder = '.centralu/apps/project-board') => {
    const app = join(top(), ...folder.split('/'))
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
  const start = (behind: number, files: string[], env: Record<string, string> = {}, folder?: string) => {
    const { app, head } = checkout(folder)
    const key = `${head}...main`
    runtime(ghState({ compareAhead: { [key]: behind }, compareFiles: { [key]: files } }), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: app, PROJECT_BOARD_CODE_CHECK_MS: '0', ...env }, gitWrapper(fake.bin))
    return { head, key }
  }
  const BOARD = ['docs/a.md', '.centralu/apps/project-board/main-guard.mjs']
  const asked = () => fake.calls().filter((c) => c.args.join(' ').includes('/compare/')).length
  /** What merge_queue says once the background question has been answered */
  const learned = async () => {
    await until((x) => !!x.code, 'the answer about the code')
    return call('merge_queue')
  }
  /** The question went out and its answer was taken in (the answer is read by the next calls) */
  const answered = async (before: number) => {
    await until(() => asked() > before, 'the question to GitHub')
    await call('merge_queue')
    await call('merge_queue')
  }

  it('shows how many commits behind, and warns a queue that has work, with board files changed since', async () => {
    waiting()
    const { head } = start(32, BOARD)
    // Nothing is waited for: the first call answers at once, with nothing about the code
    const first = await call('merge_queue')
    expect(first.isError).toBe(false)
    expect(first.data.code).toBeUndefined()
    const told = await learned()
    expect(told.isError).toBe(false)
    expect(told.text).toContain(`Board code: 32 commits behind main (running ${head.slice(0, 7)}), and the board app changed since.`)
    expect(told.text).toContain('Warning: this instance drives the merge queue with board code 32 commits behind main')
    expect(told.text).toContain('update its checkout (git pull --ff-only) and restart the app')
    expect(told.data.code).toMatchObject({ head, behind: 32, appChanged: true, warning: expect.stringContaining('git pull --ff-only') })
  })

  it('finds the app folder wherever it is in the repository, not at one fixed path', async () => {
    waiting()
    start(6, ['tools/board/queue.mjs'], {}, 'tools/board')
    let told = await learned()
    expect(told.data.code).toMatchObject({ behind: 6, appChanged: true })
    expect(told.text).toContain('Warning: this instance drives the merge queue')
    // The usual folder is somebody else's here: a change there is not a change to this app
    start(6, ['.centralu/apps/project-board/queue.mjs'], {}, 'tools/board')
    told = await learned()
    expect(told.data.code).toMatchObject({ behind: 6, appChanged: false })
    expect(told.text).not.toContain('Warning')
  })

  it('warns the main guard that drives, and says how to stop it; an instance told not to drive is not warned for it', async () => {
    drive(true)
    start(3, ['.centralu/apps/project-board/queue.mjs'], { PROJECT_BOARD_QUEUE_GUARD: 'on' })
    let told = await learned()
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
    const told = await learned()
    expect(told.text).toContain('Board code: 5 commits behind main')
    expect(told.text).toContain('none of them in the board app')
    expect(told.text).not.toContain('Warning')
    expect(told.data.code).toMatchObject({ behind: 5, appChanged: false, warning: null })
  })

  it('does not warn when the board app changed but nothing waits in the queue and the guard is off', async () => {
    start(5, BOARD)
    const told = await learned()
    expect(told.text).toContain('and the board app changed since')
    expect(told.text).not.toContain('Warning')
  })

  it('counts a changed-files list GitHub may have cut as a change to the board app', async () => {
    waiting()
    start(400, Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`))
    const told = await learned()
    expect(told.data.code).toMatchObject({ behind: 400, appChanged: true })
    expect(told.text).toContain('Warning: this instance drives the merge queue')
  })

  it('says nothing when the code is at main, not in a git checkout, unknown to GitHub, or GitHub cannot be asked, and says it once main moves', async () => {
    waiting()
    const { key } = start(0, [])
    let before = asked()
    await call('merge_queue')
    await answered(before)
    let told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
    expect(told.data.code).toBeUndefined()
    // Main moves: said once it was asked again
    patchGh((st) => (st.compareAhead[key] = 7))
    told = await learned()
    expect(told.text).toContain('Board code: 7 commits behind main')
    // GitHub cannot be asked: what was known stays, and merge_queue still answers
    patchGh((st) => (st.compareError = 'HTTP 500'))
    before = asked()
    await answered(before)
    told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).toContain('Board code: 7 commits behind main')
    patchGh((st) => delete st.compareError)
    // A commit GitHub does not know: no count
    patchGh((st) => delete st.compareAhead[key])
    before = asked()
    await answered(before)
    told = await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
    // Code that is not in a git checkout (an installed copy): no count either
    mkdirSync(join(root, 'not-git'), { recursive: true })
    runtime(ghState({}), { ...IDLE_SERVER, PROJECT_BOARD_CODE_DIR: join(root, 'not-git'), PROJECT_BOARD_CODE_CHECK_MS: '0' }, gitWrapper(fake.bin))
    told = await call('merge_queue')
    await call('merge_queue')
    expect(told.isError).toBe(false)
    expect(told.text).not.toContain('Board code')
  })

  it('compares the code the app started with, and after a pull without a restart says to restart, not to pull again', async () => {
    waiting()
    const { head } = start(2, BOARD)
    let told = await learned()
    expect(told.text).toContain(`running ${head.slice(0, 7)}`)
    expect(told.text).toContain('update its checkout (git pull --ff-only) and restart the app')
    // Someone pulls: the files change, the running code does not
    const pulled = commit('pulled')
    await until((x) => !!x.code?.moved, 'the pull to be noticed')
    told = await call('merge_queue')
    expect(told.text).toContain(`The checkout is at ${pulled.slice(0, 7)} now, not at ${head.slice(0, 7)} as the app started`)
    expect(told.text).toContain(`running ${head.slice(0, 7)}`)
    expect(told.text).toContain('restart the app (its checkout was updated since it started)')
    expect(told.text).not.toContain('git pull')
  })

  it('does not make merge_queue wait for a GitHub that accepts and does not answer for a while, and shows the answer once it comes', async () => {
    // GitHub holds its answer until the test lets it go (a time limit used to decide this under a loaded runner), in a
    // gh started on its own: one answered in the app's process (system.mjs) holds the app while it holds the answer
    waiting()
    start(4, BOARD, { PROJECT_BOARD_FAKE_PROGRAMS: '' })
    const answer = join(root, 'compare-may-answer')
    patchGh((st) => (st.compareHangs = answer))
    const first = await call('merge_queue')
    // Once the question is out and held, calls still answer, without the answer. The started gh takes a few process
    // starts to be asked (git, then gh for the repository): wait for the question itself, not for a count of calls
    while (asked() === 0) await new Promise((resolve) => setTimeout(resolve, 20))
    const calls = [first, ...(await Promise.all([call('merge_queue'), call('merge_queue')]))]
    for (const c of calls) {
      expect(c.isError).toBe(false)
      expect(c.data.code).toBeUndefined()
    }
    // And once GitHub answers, the next call shows it
    writeFileSync(answer, '')
    const told = await learned()
    expect(told.text).toContain('Board code: 4 commits behind main')
  })

  it('asks GitHub once in a while, and once at a time, not at every merge_queue', async () => {
    waiting()
    start(4, BOARD, { PROJECT_BOARD_CODE_CHECK_MS: '3600000' })
    // Three calls at once, before any answer: one question
    await Promise.all([call('merge_queue'), call('merge_queue'), call('merge_queue')])
    const told = await learned()
    expect(told.text).toContain('Board code: 4 commits behind main')
    const first = asked()
    expect(first).toBe(1)
    await call('merge_queue')
    await call('merge_queue')
    expect(asked()).toBe(first)
  })
})
