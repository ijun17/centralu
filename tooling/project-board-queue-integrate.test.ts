import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { gitWrapper } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { SLOW } from './test-timing.js'
import { g, githubStandIn } from './git-fixture.test-helpers.js'
// @ts-expect-error — plain .mjs of a Centralu app
import { GitError, isAncestor, remoteHas, showFile } from '../.centralu/apps/project-board/git.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { judgeBranch } from '../.centralu/apps/project-board/queue-integrate.mjs'
import { REPO_ROOT, SHA2, ghCheck, ghRun, ghPr, type Gh, ghState, root, fake, NO_TIERS, FAST_LAND, runtime, call, gh, patchGh, writes, notices, until, stateOf, morePolls, suiteCheck, short2, itemsOnDisk, appTmp } from './project-board-queue.test-helpers.js'

function integrateRepo(branches: Record<string, Record<string, string>>) {
  const { origin, work } = githubStandIn(root)
  const write = (f: string, text: string) => {
    mkdirSync(join(work, f, '..'), { recursive: true })
    writeFileSync(join(work, f), text)
  }
  for (const f of ['scripts/tier.mjs', '.centralu/tiers.json']) write(f, readFileSync(join(REPO_ROOT, f), 'utf8'))
  write('docs/guide.md', 'base\n')
  write('README.md', 'base\n')
  g(work, 'add', '-A')
  g(work, 'commit', '-q', '-m', 'base')
  const main = g(work, 'rev-parse', 'HEAD')
  const heads: Record<string, string> = {}
  for (const [name, files] of Object.entries(branches)) {
    g(work, 'checkout', '-q', '-b', name, main)
    for (const [f, text] of Object.entries(files)) write(f, text)
    g(work, 'add', '-A')
    if (Object.keys(files).length) g(work, 'commit', '-q', '-m', `change on ${name}`)
    heads[name] = g(work, 'rev-parse', 'HEAD')
  }
  g(work, 'checkout', '-q', '-b', 'mine', main)
  writeFileSync(join(work, 'README.md'), 'edited, not committed\n')
  g(work, 'push', '-q', 'origin', 'main', ...Object.keys(branches))
  return { work, origin, main, heads }
}

/** A later push to `branch` on GitHub's stand-in (made in a clone of the test's own): `files` added or changed */
function pushTo(repo: ReturnType<typeof integrateRepo>, branch: string, files: Record<string, string>) {
  const tmp = join(root, `push-${Date.now()}`)
  g(root, 'clone', '-q', '-b', branch, repo.origin, tmp)
  g(tmp, 'config', 'user.name', 'Tester')
  g(tmp, 'config', 'user.email', 'tester@example.test')
  g(tmp, 'config', 'commit.gpgsign', 'false')
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(tmp, f, '..'), { recursive: true })
    writeFileSync(join(tmp, f), text)
  }
  g(tmp, 'add', '-A')
  g(tmp, 'commit', '-q', '-m', `more on ${branch}`)
  g(tmp, 'push', '-q', 'origin', branch)
  return g(tmp, 'rev-parse', 'HEAD')
}

const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
/** What a session hands over: the branch and the record's text */
const handOver = (branch: string, extra: Record<string, unknown> = {}) => ({ branch, title: 'docs(guide): say how the guide is read', why: 'The guide did not say it.', notExercised: 'Nothing', owner: 'writer', ...extra })
const integrateQuick = () => [ghCheck('full tier', 'skipped', 10), ghCheck('verify', 'success', 11), ghCheck('windows tests', 'success', 12)]
const integrateBatch = (suite: number) => [suiteCheck('full tier', 'skipped', suite * 10, suite), suiteCheck('verify', 'success', suite * 10 + 1, suite), suiteCheck('windows tests', 'success', suite * 10 + 2, suite)]

/** GitHub as the queue reads it: the record #600's head is the branch's, its own quick run green, a batch's quick run green */
function integrateRuntime(repo: ReturnType<typeof integrateRepo>, branch: string, patch: Gh = {}, tmpDir = appTmp()) {
  const head = repo.heads[branch]!
  const one = `batch-${head}`
  mkdirSync(appTmp(), { recursive: true })
  const tmp = { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir }
  return runtime(
    ghState({
      prs: {},
      prHeads: { [branch]: head },
      files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE },
      checks: { [head]: integrateQuick() },
      runs: { [head]: [ghRun('success', 1, head, { head_branch: branch })] },
      on: { 'dispatch:queue/batch-1': { runs: { [one]: [ghRun('success', 1, one, { id: 950, head_branch: 'queue/batch-1', event: 'workflow_dispatch', check_suite_id: 6000 })] }, checks: { [one]: integrateBatch(6000) } } },
      ...patch,
    }),
    { ...FAST_LAND, PROJECT_BOARD_QUEUE_CHECKOUT: repo.work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'), ...tmp },
    gitWrapper(fake.bin),
  )
}
const recordsOpened = () => writes().filter((w) => w[0] === 'pr-create')

describe('the integrator lands an auto-tier branch without a pull request from its session (#1259 step 3)', { timeout: 240_000 * SLOW }, () => {
  it('judges the branch itself, opens the record from the template labelled tier:auto, queues it for the session, and lands it after the quick tier', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n', 'docs/new.md': 'new\n' } })
    integrateRuntime(repo, 'docs/guide')
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.isError, r.text).toBe(false)
    expect(r.data).toMatchObject({ integrated: true, pr: 600, opened: true, tier: 'auto', owner: 'writer' })
    expect(r.text).toContain('Integrated docs/guide: Tier: auto')
    expect(r.text).toContain('Opened #600 as its record')
    // The record: from the template, its Verified the integrator's own Tier line, labelled tier:auto
    expect(recordsOpened()).toEqual([['pr-create', 'docs/guide', 'docs(guide): say how the guide is read']])
    expect(writes().filter((w) => w[0] === 'labels')).toEqual([['labels', '600', ['tier:auto']]])
    const body = gh().prs['600'].body as string
    expect(body).toContain('## Why\n\nThe guide did not say it.')
    expect(body).toMatch(/## Verified\n\nTier: auto, from `docs\/guide\.md` \(docs\), `docs\/new\.md` \(docs\)\. Judged by the integrator \(#1259 step 3\) from the diff of docs\/guide at [0-9a-f]{7} against main at [0-9a-f]{7}/)
    expect(body).toContain('## Not exercised\n\nNothing')
    expect(itemsOnDisk()).toMatchObject([{ pr: 600, owner: 'writer', author: 'writer', auto: { branch: 'docs/guide', head: repo.heads['docs/guide'], main: repo.main } }])
    // A draft, which GitHub and every version of the queue refuse to merge: only this queue lands it
    expect(gh().prs['600']).toMatchObject({ isDraft: true, mergeStateStatus: 'DRAFT' })
    // Landed by the queue's own path: a batch of the quick tier, the squash, the branch deleted, the session told
    await until((x) => stateOf(x, 600) === 'merged', 'the record to land')
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(writes().map(short2)).toEqual(expect.arrayContaining(['merge 600', 'delete docs/guide']))
    const merge = writes().find((w) => w[0] === 'merge')!
    expect(merge[2]).toEqual(expect.arrayContaining(['--squash', '--match-head-commit', repo.heads['docs/guide']]))
    // Readied in the same step as the squash, never before
    const order = writes().map(short2)
    expect(order.filter((w) => w === 'ready 600')).toHaveLength(1)
    expect(order.indexOf('ready 600')).toBe(order.indexOf('merge 600') - 1)
    expect(notices().map((e) => e.text)).toEqual([expect.stringContaining('Merge queue: merged #600 (docs(guide): say how the guide is read)')])
    // The checkout it judged in: its branch, head and work as they were, and no ref of the integrator's left
    expect(g(repo.work, 'branch', '--show-current')).toBe('mine')
    expect(g(repo.work, 'status', '--porcelain')).toBe('M README.md')
    expect(g(repo.work, 'for-each-ref', 'refs/centralu-integrate')).toBe('')
  })

  it("refuses a branch that is not auto with the files and rules that put it there, judged by main's judge and rules, not the branch's", async () => {
    const repo = integrateRepo({
      'feat/code': { 'docs/guide.md': 'more\n', 'packages/ui/src/x.ts': 'export const x = 1\n' },
      // A branch that rewrites the judge to call everything auto, and the rules to make auto the fallback
      'docs/sneaky': {
        'scripts/tier.mjs': "console.log(JSON.stringify({ tier: 'auto', line: 'Tier: auto.', because: [], counts: { auto: 1 }, rulesFrom: process.argv[3] }))\n",
        '.centralu/tiers.json': readFileSync(join(REPO_ROOT, '.centralu/tiers.json'), 'utf8').replace('"fallback": "light"', '"fallback": "auto"'),
        'packages/ui/src/y.ts': 'export const y = 1\n',
      },
    })
    integrateRuntime(repo, 'feat/code')
    const light = await call('integrate', handOver('feat/code', { title: 'feat(ui): add x' }))
    expect(light.isError).toBe(true)
    expect(light.data).toMatchObject({ integrated: false, kind: 'tier', tier: 'light' })
    expect(light.text).toContain('Not integrated: feat/code: its tier is light, not auto.')
    expect(light.text).toContain('packages/ui/src/x.ts (no rule names it)')
    expect(light.text).toContain('Open a pull request (open_pr, after the review its tier asks for) and queue it (queue_merge).')
    const sneaky = await call('integrate', handOver('docs/sneaky'))
    expect(sneaky.isError).toBe(true)
    expect(sneaky.data).toMatchObject({ kind: 'tier', tier: 'deep' })
    expect(sneaky.text).toContain('.centralu/tiers.json (tier-rules)')
    expect(sneaky.text).toContain('scripts/tier.mjs (tier-rules)')
    // Nothing opened, labelled or queued
    expect(writes()).toEqual([])
    expect(itemsOnDisk()).toEqual([])
  })

  it("refuses a branch not on GitHub, one with nothing over main, a fork's, a title too long to squash, and an account without merge rights, before any write", async () => {
    const repo = integrateRepo({ 'docs/empty': {} })
    integrateRuntime(repo, 'docs/empty')
    const missing = await call('integrate', handOver('docs/nowhere'))
    expect(missing.data, missing.text).toMatchObject({ integrated: false, kind: 'missing' })
    expect(missing.text).toContain('the branch docs/nowhere is not on GitHub. Push it first')
    expect((await call('integrate', handOver('docs/empty'))).data).toMatchObject({ kind: 'empty' })
    expect((await call('integrate', handOver('someone:docs/guide'))).data).toMatchObject({ kind: 'fork' })
    expect((await call('integrate', handOver('main'))).data).toMatchObject({ kind: 'input' })
    const long = await call('integrate', handOver('docs/empty', { title: `docs(guide): ${'a'.repeat(60)}` }))
    expect(long.data).toMatchObject({ kind: 'subject' })
    expect((await call('integrate', handOver('docs/empty', { notExercised: '' }))).data).toMatchObject({ kind: 'record' })
    patchGh((s) => (s.permissions = { push: true }))
    const contributor = await call('integrate', handOver('docs/empty'))
    expect(contributor.data).toMatchObject({ kind: 'permission' })
    expect(contributor.text).toContain('mark_ready')
    expect(writes()).toEqual([])
    expect(itemsOnDisk()).toEqual([])
  })

  it("tells a branch not on GitHub, and a file a commit lacks, by git's exit code, whatever git prints before its error", async () => {
    // Main's CI on Windows (2026-10-27) read docs/nowhere as `retry`: the answer was read from the first line of a failed
    // fetch, so any line git printed before "couldn't find remote ref" turned it into a failure of the moment.
    // GIT_TRACE prints such lines every time.
    const repo = integrateRepo({ 'docs/empty': {}, 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    vi.stubEnv('GIT_TRACE', '1')
    try {
      const missing = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/nowhere', defaultBranch: 'main' })
      expect(missing, JSON.stringify(missing)).toMatchObject({ missing: true })
      expect(missing.retry).toBeUndefined()
      const there = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/empty', defaultBranch: 'main' })
      expect(there.missing, JSON.stringify(there)).toBeUndefined()
      expect(there.retry, JSON.stringify(there)).toBeUndefined()
      // The same for a file a commit does not have, and a commit that is its own ancestor
      const main = repo.main
      expect(await showFile(repo.work, main, 'docs/none.md')).toBeNull()
      expect(await showFile(repo.work, main, 'docs/guide.md')).toBe('base\n')
      // A revision that is not there is a caller's bug and throws, as it did for `git show` (it is not a missing file)
      await expect(showFile(repo.work, '0'.repeat(40), 'docs/guide.md')).rejects.toBeInstanceOf(GitError)
      await expect(showFile(repo.work, 'a'.repeat(40), 'docs/guide.md')).rejects.toBeInstanceOf(GitError)
      await expect(showFile(repo.work, 'no-such-branch', 'docs/guide.md')).rejects.toBeInstanceOf(GitError)
      await expect(showFile(repo.work, '-x', 'docs/guide.md')).rejects.toBeInstanceOf(GitError)
      // Not an ancestor is exit 1 with a trace line printed, not an error; an unknown commit is the error (128)
      const tip = repo.heads['docs/guide']!
      expect(await isAncestor(repo.work, main, tip)).toBe(true)
      expect(await isAncestor(repo.work, tip, main)).toBe(false)
      await expect(isAncestor(repo.work, 'a'.repeat(40), main)).rejects.toBeInstanceOf(GitError)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 60_000 * SLOW)

  it("tells a branch missing when the remote's only ref ends in its name (ls-remote matches the tail of a ref, the exact ref is checked)", async () => {
    const repo = integrateRepo({ 'foo/refs/heads/docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    expect(await remoteHas(repo.work, 'origin', 'refs/heads/foo/refs/heads/docs/guide')).toBe(true)
    expect(await remoteHas(repo.work, 'origin', 'refs/heads/docs/guide')).toBe(false)
    const r = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/guide', defaultBranch: 'main' })
    expect(r, JSON.stringify(r)).toMatchObject({ missing: true })
    expect(r.retry).toBeUndefined()
  }, 60_000 * SLOW)

  it('works through a stand-in whose folder has an apostrophe, a space and a dollar sign in its name', async () => {
    const odd = join(root, "it's a $dir")
    mkdirSync(odd)
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    remoteAnswering(repo, ['ok', 'ok', 'ok'], odd)
    const r = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/guide', defaultBranch: 'main' })
    expect(r.retry, JSON.stringify(r)).toBeUndefined()
    expect(r.missing, JSON.stringify(r)).toBeUndefined()
    expect(readFileSync(join(odd, 'calls'), 'utf8').trim()).not.toBe('')
  }, 60_000 * SLOW)

  it('keeps a failed fetch as a retry with the exit code and stderr, which fetch it was, and what ls-remote said', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const judge = (branch: string) => judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch, defaultBranch: 'main' })
    // The first fetch (main) fails: the remote is away, so ls-remote is not even asked about the branch
    renameSync(repo.origin, `${repo.origin}.away`)
    const first = await judge('docs/guide')
    renameSync(`${repo.origin}.away`, repo.origin)
    expect(first, JSON.stringify(first)).toMatchObject({ retry: true })
    expect(first.missing).toBeUndefined()
    expect(first.unjudged).toMatch(/main could not be fetched: the fetch of main \(the first fetch\) exited 128, stderr: .*fatal/)
    // The second fetch (the branch) fails while the remote lists it: a ref whose commit the remote does not have is
    // advertised by ls-remote (exit 0) and refused by the fetch (exit 128, "not our ref"). So it is not "missing"
    mkdirSync(join(repo.origin, 'refs/heads/docs'), { recursive: true })
    writeFileSync(join(repo.origin, 'refs/heads/docs/broken'), `${'a'.repeat(40)}
`)
    const second = await judge('docs/broken')
    expect(second, JSON.stringify(second)).toMatchObject({ retry: true })
    expect(second.missing).toBeUndefined()
    expect(second.unjudged).toMatch(/the branch docs\/broken could not be fetched: the fetch of docs\/broken \(the second fetch, after main was fetched\) exited 128, stderr: .*not our ref.*; ls-remote exit 0: docs\/broken is on the remote/)
    // And a branch that is not there is still missing
    expect(await judge('docs/nowhere')).toMatchObject({ missing: true })
  }, 60_000 * SLOW)

  // Real git, a bare remote, and a stand-in for upload-pack that answers each call as the plan says: `ok` as git does, `fail`
  // with an error that says nothing about a ref, `hide` as a remote that lists no branch at all (a lagging replica)
  const remoteAnswering = (repo: ReturnType<typeof integrateRepo>, plan: ('ok' | 'fail' | 'hide')[], dir = join(root, 'upload-pack')) => {
    mkdirSync(dir, { recursive: true })
    const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
    // Single-quoted for the shell whatever the path holds (a quote in it ends the quote, so it is closed, escaped and opened again)
    const quoted = (p: string) => `'${slash(p).split("'").join(`'\\''`)}'`
    const counter = quoted(join(dir, 'calls'))
    const cases = plan
      .map((what, i) => `${i + 1}${i === plan.length - 1 ? '|*' : ''}) ${what === 'ok' ? 'exec git upload-pack "$@"' : what === 'hide' ? 'exec git -c uploadpack.hideRefs=refs/heads upload-pack "$@"' : 'echo "the remote broke: stand-in failure" >&2; exit 1'};;`)
      .join('\n')
    const script = join(dir, 'upload-pack.sh')
    writeFileSync(script, `#!/bin/sh\nn=$(cat ${counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${counter}\ncase $n in\n${cases}\nesac\n`, { mode: 0o755 })
    g(repo.work, 'config', 'remote.origin.uploadpack', quoted(script))
  }

  it('says the remote listed nothing, as a retry, when ls-remote exits 2 for the branch and for main alike', async () => {
    // The main fetch is answered; then the remote hides every branch for the branch's fetch and for both ls-remote calls
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    remoteAnswering(repo, ['ok', 'hide'])
    const r = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/guide', defaultBranch: 'main' })
    expect(r, JSON.stringify(r)).toMatchObject({ retry: true })
    expect(r.missing).toBeUndefined()
    expect(r.unjudged).toMatch(/ls-remote exit 2 for docs\/guide and for main, which was fetched a moment ago: the remote listed nothing/)
  }, 60_000 * SLOW)

  it("logs a branch told missing against its fetch's own word, once, with the exit code and the end of its stderr", async () => {
    // The branch is not on the remote, but its fetch fails with an error that does not say so (the stand-in's); ls-remote
    // then answers exit 2 for the branch and lists main: missing, and the disagreement is kept in the host's log
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    remoteAnswering(repo, ['ok', 'fail', 'ok'])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/nowhere', defaultBranch: 'main' })
      expect(r, JSON.stringify(r)).toMatchObject({ missing: true })
      expect(r.retry).toBeUndefined()
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[project-board] integrate:'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/ls-remote says docs\/nowhere is not on the remote, but its fetch did not say so: the fetch of docs\/nowhere \(the second fetch\) exited 128, stderr: .*stand-in failure/)
    } finally {
      log.mockRestore()
    }
    // A fetch that does say it (git's own word) logs nothing
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      g(repo.work, 'config', '--unset', 'remote.origin.uploadpack')
      expect(await judgeBranch({ dir: repo.work, repo: 'ijun17/centralu', branch: 'docs/nowhere', defaultBranch: 'main' })).toMatchObject({ missing: true })
      expect(quiet.mock.calls.filter((c) => String(c[0]).includes('[project-board] integrate:'))).toEqual([])
    } finally {
      quiet.mockRestore()
    }
  }, 60_000 * SLOW)

  it('throws, not null, for a file the tree names but whose object cannot be read (a blobless clone with its remote away, a lost object)', async () => {
    const repo = integrateRepo({})
    const blob = g(repo.work, 'rev-parse', 'HEAD:README.md')
    const loose = join(repo.work, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
    expect(existsSync(loose)).toBe(true)
    // The blob only: the commit and its trees stay, so `HEAD:README.md` still names it
    chmodSync(loose, 0o666)
    rmSync(loose)
    const at = g(repo.work, 'rev-parse', 'HEAD')
    await expect(showFile(repo.work, at, 'README.md')).rejects.toBeInstanceOf(GitError)
    // Another file (README.md and docs/guide.md share the blob), and a file the tree does not name, are told as before
    expect(await showFile(repo.work, at, '.centralu/tiers.json')).toContain('fallback')
    expect(await showFile(repo.work, at, 'docs/none.md')).toBeNull()
  }, 60_000 * SLOW)

  // Windows cannot hold a file name with a line break in it; a POSIX file system can, and a tracked one is read by name
  it.skipIf(process.platform === 'win32')('reads a file whose name has a line break in it as that file, not as its first line (git cat-file --batch reads one name per line)', async () => {
    const repo = integrateRepo({})
    for (const [name, text] of [['d/a', 'AAA\n'], ['d/a\nb', 'NEWLINE\n'], ['d/c\rd', 'CR\n'], ['d/x', 'X\n'], ['d/x\r', 'XCR\n'],['d/e\nf', 'E\n']] as const) {
      mkdirSync(join(repo.work, 'd'), { recursive: true })
      writeFileSync(join(repo.work, name), text)
    }
    g(repo.work, 'add', '-A')
    g(repo.work, 'commit', '-q', '-m', 'names with line breaks')
    const at = g(repo.work, 'rev-parse', 'HEAD')
    expect(await showFile(repo.work, at, 'd/a')).toBe('AAA\n')
    expect(await showFile(repo.work, at, 'd/a\nb')).toBe('NEWLINE\n')
    expect(await showFile(repo.work, at, 'd/c\rd')).toBe('CR\n')
    // A trailing CR is not the end of a line to git: d/x and d/x<CR> are two files
    expect(await showFile(repo.work, at, 'd/x\r')).toBe('XCR\n')
    expect(await showFile(repo.work, at, 'd/x')).toBe('X\n')
    // Absent, though the line before the break names a file that exists: not that file's text
    expect(await showFile(repo.work, at, 'd/a\nzzz')).toBeNull()
    expect(await showFile(repo.work, at, 'd/zzz\nb')).toBeNull()
    // A folder is told as git show tells it
    expect(await showFile(repo.work, at, 'd')).toContain('tree ')
    // And a revision that is not there still throws, whatever the name has in it
    await expect(showFile(repo.work, 'no-such-branch', 'd/a\nb')).rejects.toBeInstanceOf(GitError)
    await expect(showFile(repo.work, 'a'.repeat(40), 'd/a\nzzz')).rejects.toBeInstanceOf(GitError)
  }, 60_000 * SLOW)

  it('takes the record already open from the branch when it is handed over again, and queues it again, never a second pull request', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    // Its own run still going: nothing lands while the test hands it over twice
    integrateRuntime(repo, 'docs/guide', { checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    expect((await call('integrate', handOver('docs/guide'))).data).toMatchObject({ integrated: true, pr: 600, opened: true })
    // Marked ready by someone meanwhile (mark_ready, a person): the queue turns it back into a draft before anything else
    patchGh((s) => Object.assign(s.prs['600'], { isDraft: false, mergeStateStatus: 'CLEAN' }))
    await until(() => gh().prs['600'].isDraft === true, 'the record to be a draft again')
    expect(writes().map(short2)).toContain('draft 600')
    const again = await call('integrate', handOver('docs/guide'))
    expect(again.isError, again.text).toBe(false)
    expect(again.data).toMatchObject({ integrated: true, pr: 600, opened: false })
    expect(again.text).toContain('#600, open from it already, is its record')
    expect(again.text).toContain('queued it again')
    expect(recordsOpened()).toHaveLength(1)
    expect(itemsOnDisk().filter((i) => i.state !== 'merged').map((i) => i.pr)).toEqual([600])
  })

  it("judges from a temporary folder reached through a link, as macOS's /var is (/private/var)", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    mkdirSync(appTmp(), { recursive: true })
    const link = join(root, 'tmp-link')
    symlinkSync(appTmp(), link, process.platform === 'win32' ? 'junction' : 'dir')
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', { checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} }, link)
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.isError, r.text).toBe(false)
    expect(r.data).toMatchObject({ integrated: true, tier: 'auto' })
    // Nothing of the judge's own left in the temporary folder
    expect(readdirSync(appTmp()).filter((f) => f.startsWith('centralu-integrate-'))).toEqual([])
  })

  it('refuses a pull request open from the branch that a label puts above auto, and turns one it takes into a draft', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    const open = ghPr(590, { headRefName: 'docs/guide', headRefOid: head, labels: [{ name: 'documentation' }, { name: 'tier:person' }] })
    integrateRuntime(repo, 'docs/guide', { prs: { '590': open }, checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    const person = await call('integrate', handOver('docs/guide'))
    expect(person.data).toMatchObject({ integrated: false, kind: 'label', tier: 'person', pr: 590 })
    expect(person.text).toContain('#590, open from docs/guide, is labelled tier:person, and integrate lands only auto.')
    expect(writes()).toEqual([])
    // Without a tier label above auto it is the record, and a draft from then on
    patchGh((s) => (s.prs['590'].labels = [{ name: 'documentation' }]))
    const taken = await call('integrate', handOver('docs/guide'))
    expect(taken.data).toMatchObject({ integrated: true, pr: 590, opened: false })
    expect(writes().map(short2)).toEqual(['draft 590'])
    expect(gh().prs['590'].isDraft).toBe(true)
  })

  it('says to try again when GitHub cannot be reached to judge it, rather than calling it deep', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    integrateRuntime(repo, 'docs/guide')
    renameSync(repo.origin, `${repo.origin}.away`)
    const r = await call('integrate', handOver('docs/guide'))
    renameSync(`${repo.origin}.away`, repo.origin)
    expect(r.data).toMatchObject({ integrated: false, kind: 'retry' })
    expect(r.text).toContain('Nothing was written; integrate again in a moment.')
    expect(writes()).toEqual([])
  })

  it("refuses an answer of main's judge whose rules did not come from main", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    pushTo(repo, 'main', { 'scripts/tier.mjs': "console.log(JSON.stringify({ tier: 'auto', line: 'Tier: auto.', because: [], counts: { auto: 1 }, rulesFrom: 'elsewhere' }))\n" })
    integrateRuntime(repo, 'docs/guide')
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: false, kind: 'tier', tier: 'deep' })
    expect(r.text).toContain('the rules were not read from main')
  })

  it.each([
    { name: 'GitHub refuses the squash', patch: { mergeError: 'GraphQL: Pull Request is not mergeable (HTTP 405)' }, merge: false, reason: 'refused' },
    { name: 'a rate limit stops it mid-way', patch: { mergeError: 'API rate limit exceeded for user ID 1. (HTTP 403)' }, merge: false, reason: null },
    { name: 'GitHub holds the squash (its own merge queue)', patch: { mergeNoop: true }, merge: true, reason: 'not-merged' },
  ])('turns the record back into a draft when $name after readying it', async ({ patch, merge, reason }) => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    integrateRuntime(repo, 'docs/guide', patch)
    await call('integrate', handOver('docs/guide'))
    // The poll that turns it back says why at once; the next one may say what it lands from instead
    const q = await until((x) => writes().some((w) => w[0] === 'draft' && w[1] === '600') && (!reason || stateOf(x, 600) === 'attention'), 'the record to be a draft again')
    const order = writes().map(short2).filter((w) => /^(ready|merge|draft) 600$/.test(w))
    expect(order).toEqual(merge ? ['ready 600', 'merge 600', 'draft 600'] : ['ready 600', 'draft 600'])
    expect(gh().prs['600']).toMatchObject({ state: 'OPEN', isDraft: true })
    if (reason) {
      const item = q.queue.find((i: any) => i.pr === 600)
      expect(item.reason.kind).toBe(reason)
      if (reason === 'not-merged') expect(item.reason.text).toContain('it was turned back into a draft, which also stops what GitHub held')
    }
  })

  it('refuses where the queue does not batch with two tiers of CI: a draft record would have no gate', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    mkdirSync(appTmp(), { recursive: true })
    runtime(ghState({ prs: {}, files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE } }), { ...NO_TIERS, PROJECT_BOARD_QUEUE_CHECKOUT: repo.work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig') }, gitWrapper(fake.bin))
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: false, kind: 'setup' })
    expect(r.text).toContain('does not batch with two tiers of CI')
    expect(writes()).toEqual([])
  })

  it("never takes a fork's open pull request whose branch has the same name as the record", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', { prs: { '590': ghPr(590, { headRefName: 'docs/guide', isCrossRepository: true, headRefOid: SHA2 }) }, checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: true, pr: 600, opened: true })
    expect(itemsOnDisk().map((i) => i.pr)).toEqual([600])
  })
})

describe('the queue judges an integrated change again on each new head and before it lands (#1259 step 3)', { timeout: 240_000 * SLOW }, () => {
  /** Its own run still going: nothing lands until the test says CI passed */
  const pending = (head: string) => ({ checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
  /**
   * CI passed on `head` (its own quick run), and a batch of it passes the quick tier: whenever its batch was started,
   * before this or after (it may have been batched while its own run was still going)
   */
  const passes = (s: Gh, head: string) => {
    const one = `batch-${head}`
    s.checks[head] = integrateQuick()
    s.runs[head] = [ghRun('success', 1, head, { head_branch: 'docs/guide' })]
    // The batch is queue/batch-1, or a later one when an earlier batch was dropped (its head moved): runs are read on its branch
    s.runs[one] = [1, 2, 3].map((n) => ghRun('success', 1, one, { id: 950 + n, head_branch: `queue/batch-${n}`, event: 'workflow_dispatch', check_suite_id: 6000 }))
    s.checks[one] = integrateBatch(6000)
  }
  const tierNotices = () => notices().filter((e) => e.kind === 'attention' && e.text.includes('needs attention: tier'))

  it('stops a head pushed after the hand-over that is no longer auto: attention for the session with the files, never batched or landed', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    expect((await call('integrate', handOver('docs/guide'))).data).toMatchObject({ integrated: true, pr: 600 })
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // The session pushes code to the same branch, and CI passes on it
    const code = pushTo(repo, 'docs/guide', { 'packages/ui/src/x.ts': 'export const x = 1\n' })
    patchGh((s) => {
      s.prs['600'].headRefOid = code
      passes(s, code)
    })
    await until((x) => stateOf(x, 600) === 'attention', 'attention')
    const item = (await call('merge_queue')).data.queue.find((i: any) => i.pr === 600)
    expect(item.reason.kind).toBe('tier')
    expect(item.reason.text).toContain(`#600 was handed over with integrate as an auto-tier change, but at ${code.slice(0, 7)} its tier is now light, from packages/ui/src/x.ts (no rule names it).`)
    expect(item.reason.text).toContain('queue it with queue_merge')
    // Once, to the session that handed it over; the new head in no batch (the first one may have been), nothing landed
    await morePolls(3)
    expect(tierNotices()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'merge-into' && w[1] === code)).toEqual([])
    expect(writes().map(short2)).not.toContain('merge 600')
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head: code, tier: 'light', main: repo.main })
  })

  it('judges it once more right before the squash, against main as it is then: rules main changed since make it deep, and it does not land', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // Main moves on after that judgment: its rules now call docs deep
    const rules = JSON.parse(readFileSync(join(REPO_ROOT, '.centralu/tiers.json'), 'utf8'))
    rules.rules.find((r: any) => r.id === 'docs').tier = 'deep'
    pushTo(repo, 'main', { '.centralu/tiers.json': `${JSON.stringify(rules, null, 2)}\n` })
    patchGh((s) => passes(s, head))
    await until((x) => stateOf(x, 600) === 'attention', 'attention')
    // It was batched on the poll's judgment of its head, and stopped at the squash
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(writes().map(short2)).not.toContain('merge 600')
    // No "Passed CI in the batch" status on a head that does not land
    expect(writes().filter((w) => w[0] === 'status')).toEqual([])
    expect(tierNotices().map((e) => e.text)).toEqual([expect.stringContaining(`but at ${head.slice(0, 7)} its tier is now deep, from docs/guide.md (docs)`)])
    // The judgment stays on the item for that head: polls do not try to land it again
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head, tier: 'deep' })
    await morePolls(2)
    expect(writes().filter((w) => w[0] === 'merge')).toEqual([])
  })

  it('retries a head it could not judge (GitHub out of reach) as a failed poll, tells nobody on a blip, and lands it once judged', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // A new auto head, read while GitHub's copy cannot be fetched
    const more = pushTo(repo, 'docs/guide', { 'docs/more.md': 'more\n' })
    renameSync(repo.origin, `${repo.origin}.away`)
    // The fake's state is written whole by both sides, and patchGh reads, changes and writes it back: a write of the fake gh
    // (a batch forming around the first head: dispatch, merge) between the read and the write loses the new head, and nothing
    // ever judges it (seen in this pull request's Windows CI: the item sat in batch-1 at the old head for the whole wait, lastError
    // empty). So the new head is set again on each look until the poll has read it.
    await until(() => {
      if (gh().prs['600'].headRefOid !== more) patchGh((s) => (s.prs['600'].headRefOid = more))
      return /the integrator could not judge #600/.test(itemsOnDisk()[0]?.lastError ?? '')
    }, 'a poll that could not judge it')
    expect(stateOf((await call('merge_queue')).data, 600)).not.toBe('attention')
    expect(tierNotices()).toEqual([])
    // Back in reach, and CI passed: judged auto, and it lands
    renameSync(`${repo.origin}.away`, repo.origin)
    await until((x) => {
      if (!gh().runs[more]) patchGh((s) => passes(s, more)) // set again until it holds, as above
      return stateOf(x, 600) === 'merged'
    }, 'the record to land')
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head: more, tier: 'auto' })
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
  })

  it('stops it when a person labels it above auto after the hand-over, whatever the judge said, and lands nothing', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // The owner raises it by hand, and CI passes
    patchGh((s) => {
      s.prs['600'].labels = [{ name: 'tier:auto' }, { name: 'tier:deep' }]
      passes(s, head)
    })
    await until((x) => stateOf(x, 600) === 'attention', 'attention')
    const item = (await call('merge_queue')).data.queue.find((i: any) => i.pr === 600)
    expect(item.reason.kind).toBe('tier')
    expect(item.reason.text).toContain('#600 was handed over with integrate, but it is labelled tier:deep')
    await morePolls(2)
    expect(writes().map(short2)).not.toContain('merge 600')
    expect(writes().map(short2)).not.toContain('ready 600')
    expect(gh().prs['600'].isDraft).toBe(true)
  })

  it('lands a record as a pull request of its own tier only after it is taken out, marked ready and queued with queue_merge', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    expect(itemsOnDisk()[0].auto).toBeTruthy()
    // Still the integrator's: a draft, which queue_merge refuses like any draft
    const refused = await call('queue_merge', { pr: 600, owner: 'writer' })
    expect(refused.text).toContain('#600 is a draft')
    await call('unqueue', { pr: 600 })
    // Marked ready by the session (the fake's state is written whole by both sides: set it until it holds)
    let queued = { isError: true, text: '' }
    for (let i = 0; i < 20 && queued.isError; i++) {
      patchGh((st) => Object.assign(st.prs['600'], { isDraft: false, mergeStateStatus: 'CLEAN' }))
      queued = await call('queue_merge', { pr: 600, owner: 'writer' })
    }
    expect(queued.text).toContain('Queued #600')
    const item = itemsOnDisk().find((i) => i.state !== 'removed' && i.pr === 600)
    expect(item.auto).toBeUndefined()
    expect(item.tierAt).toBeUndefined()
    // Not the integrator's any more: never turned back into a draft
    await morePolls(2)
    expect(writes().map(short2)).not.toContain('draft 600')
  })
})

// --- Messages kept until their owner acknowledges them (#1351) --------------------------------------------------------

