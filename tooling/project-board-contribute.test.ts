import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownProcesses } from '../packages/agent-host/src/process.test-helpers.js'
import { gitWrapper, removeFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import {
  commitProblems,
  englishProblems,
  fillTemplate,
  foreignBareIssueWarnings,
  normalizeWords,
  parseConventions,
  privateWordHits,
  publicTextProblems,
  subjectProblems,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/rules.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { topLevel } from '../.centralu/apps/project-board/git.mjs'
import { fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'

/**
 * The project board's contribution tools (#386 step 2): comment, file_issue, open_pr, commit_check,
 * rebase_stack and the private word list. First the rules as pure functions (rules.mjs), held to
 * this repository's own documents; then the app under the real external-app runtime against a fake
 * `gh` that records every write and never reaches GitHub; rebase_stack runs real git on repositories
 * made here, with a bare one standing for GitHub's.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
const CONVENTIONS_DOC = readFileSync(join(REPO_ROOT, 'docs/commit-conventions.md'), 'utf8')
const CONVENTIONS = parseConventions(CONVENTIONS_DOC)

describe('the rules for public text', () => {
  it('warns when prose attributes a bare issue number to another repository', () => {
    expect(foreignBareIssueWarnings('Fixed in other/repo #42.', 'ijun17/centralu', 'The comment')).toEqual([
      'The comment attributes bare #42 to another repository (other/repo#42). Write the reference as owner/repo#N so it cannot link here by mistake.',
    ])
    expect(foreignBareIssueWarnings('Fixed in #42.', 'ijun17/centralu')).toEqual([])
  })

  it('reads English, and lets code, quotes and addresses be in any language', () => {
    expect(englishProblems('Fold it into #406, the smaller change (Δt ≈ 3 µs) 👍')).toEqual([])
    expect(englishProblems('이것은 영어가 아닙니다. Please fold it.', 'The comment')).toEqual([
      'The comment is not in English ("이것은 영어가 아닙니다"). Write it in English; a word whose exact form matters goes in backticks or a > quote (CONTRIBUTING.md, Language).',
    ])
    expect(englishProblems('Japanese: これは日本語です')).toHaveLength(1)
    // Quoted verbatim where the exact words matter, as CONTRIBUTING.md asks
    expect(englishProblems('The button says `새 세션` and the log:\n\n```\n오류: 실패\n```\n\n> 원문 그대로\n\nhttps://ko.wikipedia.org/wiki/한글')).toEqual([])
  })

  it('finds private words whole and in any case, in code and addresses too, and never inside another word', () => {
    const words = normalizeWords(['  Moonbase ', 'moonbase', 'Side Quest', '', 'Gram'])
    expect(words).toEqual(['Gram', 'Moonbase', 'Side Quest'])
    expect(privateWordHits('Tested on the MOONBASE build', words)).toEqual(['Moonbase'])
    expect(privateWordHits('see `side-quest/config` and https://x.example/side_quest', words)).toEqual(['Side Quest'])
    expect(privateWordHits('a kilogram, programs, Moonbases', words)).toEqual([])
    expect(publicTextProblems('Ran it on the Gram.', words, 'The comment')).toEqual([
      'The comment contains a word from the private list: "Gram". Leave it out or say it in general terms.',
    ])
  })

  it('refuses attribution lines in any public text', () => {
    expect(publicTextProblems('Done.\n\nCo-Authored-By: Someone <a@b.c>\n🤖 Generated with [Claude Code](https://claude.com)', [], 'The body')).toEqual([
      'The body carries attribution lines ("Co-Authored-By: Someone <a@b.c>", "🤖 Generated with [Claude Code](https://claude.com)"). Remove them: nothing here is signed by a tool (docs/commit-conventions.md).',
    ])
  })

  it("reads this repository's commit conventions: its types, its subject length and its wrap", () => {
    expect(CONVENTIONS).toEqual({ types: ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'build', 'ci', 'chore', 'revert'], subjectMax: 72, bodyWrap: 72 })
  })

  it.each([
    'feat(ui): let the orchestrator join grid',
    'fix(agent-host): gate ask_project on trust',
    'docs: define conventional commit messages',
    'feat(protocol)!: rename turn status',
    'chore(release): 0.1.0-beta.16',
    'fix: keep VS Code links working',
  ])('accepts the subject %j', (s) => {
    expect(subjectProblems(s, CONVENTIONS)).toEqual({ problems: [], warnings: [] })
  })

  it.each([
    ['Fix the login bug', /not <type>\(<scope>\): <description>/],
    ['feature(ui): add a thing', /"feature" is not a commit type here/],
    ['fix(UI): add a thing', /scope "UI" must be lowercase/],
    ['fix(ui): Add a thing', /starts with a capital \("Add"\)/],
    ['fix(ui): add a thing.', /ends with a period/],
    ['fix(ui):  add a thing', /spaces at its start/],
    ['fix(ui): ', /description after the colon is empty/],
  ])('refuses the subject %j', (s, why) => {
    expect(subjectProblems(s, CONVENTIONS).problems.join(' ')).toMatch(why)
  })

  // The length rule at its edge: 72 passes, 73 does not, in characters rather than bytes
  it.each([70, 71, 72, 73, 74])('a subject of %i characters is %s', (n) => {
    const subject = `fix(ui): ${'ä'.repeat(n - 'fix(ui): '.length)}`
    expect([...subject]).toHaveLength(n)
    expect(subjectProblems(subject, CONVENTIONS).problems.some((p: string) => p.includes('keep it at 72 or fewer'))).toBe(n > 72)
  })

  it('warns on a description that reports instead of commanding, without refusing it', () => {
    expect(subjectProblems('fix(ui): added a guard', CONVENTIONS)).toEqual({ problems: [], warnings: ['"added" reads as a report; the description is imperative ("add", not "added" or "adds").'] })
    expect(subjectProblems('fix(ui): adds a guard', CONVENTIONS).warnings).toHaveLength(1)
    expect(subjectProblems('fix(ui): focus the composer', CONVENTIONS).warnings).toEqual([])
    expect(subjectProblems('fix(ui): bring the panel forward', CONVENTIONS).warnings).toEqual([])
  })

  it('checks a whole message: the blank second line, the wrap, and the rules for public text', () => {
    expect(commitProblems('fix(ui): keep focus\n\nThe composer lost the caret after the palette closed.\n\nRefs: #115', CONVENTIONS)).toEqual({ problems: [], warnings: [] })
    expect(commitProblems('fix(ui): keep focus\nno blank line', CONVENTIONS).problems).toEqual([
      'The second line must be blank: the subject stands alone, and the body starts after an empty line.',
    ])
    const long = commitProblems(`fix(ui): keep focus\n\n${'word '.repeat(20)}\n\n${'x'.repeat(100)}\nhttps://example.com/${'a'.repeat(80)}`, CONVENTIONS)
    expect(long.problems).toEqual([])
    expect(long.warnings).toEqual(['Body lines 3, 5 are longer than 72 characters; wrap prose at 72.'])
    expect(commitProblems('fix(ui): keep focus\n\nCo-Authored-By: Claude <noreply@anthropic.com>', CONVENTIONS).problems).toHaveLength(1)
    expect(commitProblems('fix(ui): keep focus\n\n포커스를 유지한다', CONVENTIONS).problems.join()).toMatch(/not in English/)
    expect(commitProblems('fix(ui): keep moonbase focus', CONVENTIONS, ['Moonbase']).problems.join()).toMatch(/private list: "Moonbase"/)
  })

  const SECTIONS = { why: 'Because.', whatChanged: 'This.', verified: 'Ran it.', situationsChecked: 'n/a', usability: 'n/a', notExercised: 'Windows.', closes: 'Closes #1' }

  it("fills this repository's pull request template, without its guidance, in its order", () => {
    const r = fillTemplate(TEMPLATE, { 'Not exercised': 'Windows.', Why: 'Because.', 'what changed': 'This.', Verified: 'Ran it.', 'situations checked': 'Host swap: unchanged.', Usability: 'n/a', closes: 'Closes #1' })
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body).toBe('## Why\n\nBecause.\n\n## What changed\n\nThis.\n\n## Verified\n\nRan it.\n\n## Situations checked\n\nHost swap: unchanged.\n\n## Usability\n\nn/a\n\n## Not exercised\n\nWindows.\n\n## Closes\n\nCloses #1')
    expect(r.body).not.toMatch(/<!--/)
  })

  it.each([undefined, '', '  ', 'N/A', 'n/a', '-', 'TBD', 'none'])('refuses "Not exercised" given as %j', (value) => {
    const r = fillTemplate(TEMPLATE, { ...SECTIONS, notExercised: value })
    expect(r.problems.join()).toMatch(/"Not exercised" is (empty|only)/)
  })

  it('takes "Nothing" for Not exercised, keeps Situations checked and Usability as the template asks, drops other headings left out, and refuses a heading it does not have', () => {
    const kept = { 'Not exercised': 'Nothing', 'Situations checked': 'n/a', Usability: 'n/a' }
    expect(fillTemplate(TEMPLATE, kept).problems).toEqual([])
    const noUsability = fillTemplate(TEMPLATE, { 'Not exercised': 'Nothing', 'Situations checked': 'n/a' })
    expect(noUsability.problems.join()).toMatch(/"Usability" is empty, and the template keeps it/)
    // The self-attack review (#1181): an author who skips it is sent to the situations, not let through
    const noSituations = fillTemplate(TEMPLATE, { 'Not exercised': 'Nothing', Usability: 'n/a' })
    expect(noSituations.problems.join()).toMatch(/"Situations checked" is empty, and the template keeps it: .*Host swap/)
    const dropped = fillTemplate(TEMPLATE, { ...kept, Why: 'Because.' })
    expect(dropped.warnings).toEqual(['"What changed" is left out.', '"Verified" is left out.', '"Closes" is left out.'])
    expect(dropped.body).toBe('## Why\n\nBecause.\n\n## Situations checked\n\nn/a\n\n## Usability\n\nn/a\n\n## Not exercised\n\nNothing')
    expect(fillTemplate(TEMPLATE, { ...SECTIONS, Screenshots: 'x' }).problems).toEqual([
      'The template has no heading "Screenshots". Its headings: Why, What changed, Verified, Situations checked, Usability, Not exercised, Closes.',
    ])
  })
})

// --- The app, against a fake gh ---------------------------------------------------------------------

/** How the fake gh answers (fake-gh.test-helpers.ts gives it args, stdin, st and save, and logs each call) */
const FAKE_GH = String.raw`
const fail = (stderr, code = 1, stdout = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code) }
const json = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0) }
if (st.mode === 'offline') fail('error connecting to api.github.com\n')
const REPO = 'ijun17/centralu'
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = st.prs[args[2]]
  if (!pr) fail('GraphQL: Could not resolve to a PullRequest with the number of ' + args[2] + '.\n')
  json(pr)
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (args.includes('--base')) json(Object.values(st.prs).filter((p) => p.baseRefName === args[args.indexOf('--base') + 1] && p.state === 'OPEN'))
  const head = args[args.indexOf('--head') + 1]
  json(Object.values(st.prs).filter((p) => p.headRefName === head))
}
if (args[0] === 'pr' && args[1] === 'ready') {
  const p = st.prs[args[2]]
  if (!p) fail('GraphQL: Could not resolve to a PullRequest with the number of ' + args[2] + '.\n')
  p.isDraft = args.includes('--undo')
  save()
  process.exit(0)
}
if (args[0] === 'api' && args[1] === '-X') {
  const [method, path] = [args[2], args[3]]
  const body = JSON.parse(stdin)
  if (method === 'POST' && path === 'repos/' + REPO + '/pulls') {
    if (st.prExists) fail('gh: Validation Failed (HTTP 422)\n', 1, JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for ijun17:' + body.head + '.' }] }))
    json({ number: 900, html_url: 'https://github.com/' + REPO + '/pull/900' })
  }
  if (method === 'POST' && path === 'repos/' + REPO + '/issues') json({ number: 901, html_url: 'https://github.com/' + REPO + '/issues/901' })
  const comment = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path)
  if (method === 'POST' && comment) json({ id: 1, node_id: 'IC_1', html_url: 'https://github.com/' + REPO + '/issues/' + comment[1] + '#issuecomment-1', body: body.body, created_at: '2026-10-12T10:00:00Z', user: { login: 'owner' } })
  const labels = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(path)
  if (method === 'POST' && labels) {
    if (st.labelsRefused) fail('gh: Resource not accessible by integration (HTTP 403)\n', 1, '{"message":"Resource not accessible by integration"}')
    json(body.labels.map((name) => ({ name })))
  }
  const pull = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path)
  if (method === 'PATCH' && pull) {
    st.prs[pull[1]].baseRefName = body.base
    save()
    json({ number: Number(pull[1]) })
  }
}
if (args[0] === 'api' && args[1] === '-H') {
  const m = /^repos\/[^/]+\/[^/]+\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(args[3])
  const text = m && st.files[decodeURIComponent(m[1])]
  if (text === undefined || text === null) fail('gh: Not Found (HTTP 404)\n', 1, '{"message":"Not Found"}')
  process.stdout.write(text)
  process.exit(0)
}
if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1])) json({ default_branch: 'main', permissions: { admin: true, maintain: true, push: true } })
fail('fake gh: unexpected call ' + JSON.stringify(args) + '\n')
`

const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }
let root = ''
/** Where git is, when the PATH has to be told (gitWrapper) */
let gitDirs: string[] = []
let rt: ExternalApps | null = null
let gh: FakeGh

type Pr = { number: number; state: string; headRefName: string; baseRefName: string; headRefOid: string; mergeCommit: { oid: string } | null; isCrossRepository: boolean; title: string; body: string; isDraft: boolean; mergeable: string; url: string }
type State = { mode: string; files: Record<string, string | null>; prs: Record<string, Pr>; prExists?: boolean; labelsRefused?: boolean }

const pr = (number: number, extra: Partial<Pr>): Pr => ({
  number,
  state: 'OPEN',
  headRefName: `b${number}`,
  baseRefName: 'main',
  headRefOid: '0'.repeat(40),
  mergeCommit: null,
  isCrossRepository: false,
  title: `PR ${number}`,
  body: '',
  isDraft: false,
  mergeable: 'MERGEABLE',
  url: `https://github.com/ijun17/centralu/pull/${number}`,
  ...extra,
})

/**
 * git as the app finds it on its PATH: the real binary, called through a wrapper, so the folder git
 * lives in (Homebrew's often holds the real gh too) is never on the app's PATH.
 */

beforeEach(() => {
  // The long form of the folder, which is what git answers: a runner's temp folder is named with 8.3 (RUNNER~1)
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-contribute-')))
  mkdirSync(join(root, 'data'))
  gh = fakeGh(root, FAKE_GH)
  gitDirs = gitWrapper(gh.bin)
  const state: State = {
    mode: 'ok',
    files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE, 'docs/commit-conventions.md': CONVENTIONS_DOC },
    prs: {},
  }
  gh.setState(state)
})

afterEach(async () => {
  // Until the app and what it left running have ended: they run Node from this folder and write in it
  await rt?.dispose({ awaitTree: true })
  rt = null
  await removeFakeDir(root)
})

function runtime() {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: gh.env({ GIT_CONFIG_NOSYSTEM: '1' }, gitDirs),
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown> = {}, caller: AppCaller = agent) {
  const out = await rt!.call(ref, name, args, caller)
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as any }
}
const ghCalls = () => gh.calls()
const writes = () => ghCalls().filter((c) => c.args[0] === 'api' && c.args[1] === '-X')
const patchState = (fn: (s: State) => void) => gh.patchState<State>(fn)
function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesNamed(join(dir, e.name), name) : e.name === name ? [join(dir, e.name)] : []))
}

describe('the board app carries the contribution procedure', { timeout: 60_000 * SLOW }, () => {
  it('passes check, with the new tools annotated and open to agents', async () => {
    const r = await runtime().check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    for (const line of [
      'comment — changes, model',
      'save_answer — changes, app',
      'file_issue — changes, model',
      'open_pr — changes, model',
      'commit_check — reads, model',
      'rebase_stack — changes, model',
      'private_words — reads, model+app',
      'edit_private_words — changes, model+app',
    ])
      expect(r.text).toContain(line)
  })

  it('keeps the private word list in the data folder, never in the repository, and edits it', async () => {
    runtime()
    expect((await call('private_words')).data).toMatchObject({ count: 0, words: [] })
    const added = await call('edit_private_words', { add: ['Moonbase', ' side quest ', 'moonbase'] })
    expect(added.data.summary).toBe('Added "Moonbase", "side quest". 2 private words.')
    expect(added.data.words).toEqual(['Moonbase', 'side quest'])
    const removed = await call('edit_private_words', { remove: ['MOONBASE'] })
    expect(removed.data.summary).toBe('Removed "Moonbase". 1 private word.')
    const [file] = filesNamed(join(root, 'data'), 'private-words.json')
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual({ words: ['side quest'] })
    expect(existsSync(join(REPO_ROOT, '.centralu/apps/project-board/private-words.json'))).toBe(false)
    expect(filesNamed(join(REPO_ROOT, '.centralu/apps/project-board'), 'private-words.json')).toEqual([])
  })

  /*
   * The screen's dialog and an agent may edit the list at the same moment. Each edit reads the list,
   * then writes it whole: two at once must not both start from the list before either, or the later
   * write drops the earlier one's word. They run one at a time, like every other write.
   */
  it('keeps both words when two edits of the private list arrive at once', async () => {
    runtime()
    const words = ['Moonbase', 'Side quest', 'Lantern', 'Harbor']
    await Promise.all(words.map((w) => call('edit_private_words', { add: [w] })))
    expect([...(await call('private_words')).data.words].sort()).toEqual([...words].sort())
  })

  /*
   * The owner answers decisions in Korean on the screen, and that text is saved on this computer, not
   * posted (tooling/project-board-reader.test.ts). What reaches GitHub is an agent's comment, held to
   * English, the private list and no attribution.
   */
  const KOREAN = '**Decision (owner, 2026-10-12):** A로 갑니다. #406에 합칩니다.'

  it("refuses an agent's comment that is not in English, and lets it quote the exact words in code", async () => {
    runtime()
    const agentTry = await call('comment', { item: 113, body: KOREAN })
    expect(agentTry.isError).toBe(true)
    expect(agentTry.text).toBe(
      'Not posted on #113: The comment is not in English ("로 갑니다"). Write it in English; a word whose exact form matters goes in backticks or a > quote (CONTRIBUTING.md, Language).',
    )
    expect(writes()).toEqual([])
    expect((await call('comment', { item: 113, body: 'The owner chose A: `A로 갑니다`.' })).isError).toBe(false)
    expect(writes()).toHaveLength(1)
  })

  it.each([
    ['a private word', 'Tested on the Moonbase build.', /private list: "Moonbase"/],
    ['an attribution line', 'Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', /attribution lines/],
  ])("refuses %s in an agent's comment", async (_, agentText, why) => {
    runtime()
    await call('edit_private_words', { add: ['Moonbase'] })
    const agentTry = await call('comment', { item: 113, body: agentText })
    expect(agentTry.isError).toBe(true)
    expect(agentTry.text).toMatch(why)
    expect(writes()).toEqual([])
  })

  it('files an issue after the same checks, or checks only with dryRun', async () => {
    runtime()
    await call('edit_private_words', { add: ['Moonbase'] })
    const refused = await call('file_issue', { title: 'Crash in the Moonbase build', body: 'Steps.' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe(
      ['Not filed: One rule fails; nothing was sent to GitHub.', 'The title contains a word from the private list: "Moonbase". Leave it out or say it in general terms.'].join('\n'),
    )
    expect((await call('file_issue', { title: 'A crash on start', body: 'Steps.', dryRun: true })).text).toBe('Ready to file "A crash on start" on ijun17/centralu (dry run, nothing sent).')
    expect(writes()).toEqual([])
    const filed = await call('file_issue', { title: 'A crash on start', body: 'Steps.', labels: ['bug'] })
    expect(filed.text).toBe('Filed #901 "A crash on start": https://github.com/ijun17/centralu/issues/901')
    expect(writes()).toEqual([{ args: ['api', '-X', 'POST', 'repos/ijun17/centralu/issues', '--input', '-'], stdin: JSON.stringify({ title: 'A crash on start', body: 'Steps.', labels: ['bug'] }) }])
  })

  const PR = {
    title: 'feat(apps): add contribution tools to the board',
    head: 'feat/tools',
    why: 'Procedure errors.',
    whatChanged: 'Tools.',
    verified: 'Tests.',
    situationsChecked: 'Two at once: each call opens its own.',
    usability: 'n/a',
    notExercised: 'The packaged app.',
    closes: 'Refs #386',
    // pnpm pre-pr has its own tests below, on a checkout made for them
    skipPrePr: 'The template is what these tests are about.',
  }

  it("opens a pull request with the repository's template filled from its base branch", async () => {
    runtime()
    const r = await call('open_pr', PR)
    expect(r.isError).toBe(false)
    expect(r.text).toBe('Opened #900 "feat(apps): add contribution tools to the board" from feat/tools into main: https://github.com/ijun17/centralu/pull/900 Labelled tier:deep.')
    const [post] = writes()
    expect(post!.args).toEqual(['api', '-X', 'POST', 'repos/ijun17/centralu/pulls', '--input', '-'])
    expect(JSON.parse(post!.stdin!)).toEqual({
      title: PR.title,
      head: 'feat/tools',
      base: 'main',
      draft: false,
      body: '## Why\n\nProcedure errors.\n\n## What changed\n\nTools.\n\n## Verified\n\nTests.\n\n`pnpm pre-pr` was not run: The template is what these tests are about.\nTier: deep (pnpm pre-pr was not run, so the paths were not judged).\n\n## Situations checked\n\nTwo at once: each call opens its own.\n\n## Usability\n\nn/a\n\n## Not exercised\n\nThe packaged app.\n\n## Closes\n\nRefs #386',
    })
    // The template was read from the base branch, the place a pull request cannot change for itself
    expect(ghCalls().find((c) => c.args.some((a) => a.includes('/contents/')))!.args[3]).toBe('repos/ijun17/centralu/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=main')
  })

  // #1066: a stack's lower pull requests are drafts, and build.yml runs no CI for a draft
  it('turns the pull request a new one is stacked on into a draft, and leaves one on main alone', async () => {
    patchState((s) => {
      s.prs['5'] = pr(5, { headRefName: 'feat/low' })
      s.prs['6'] = pr(6, { headRefName: 'feat/lower-draft', isDraft: true })
    })
    runtime()
    const dry = await call('open_pr', { ...PR, base: 'feat/low', dryRun: true })
    expect(dry.text).toContain("Would turn #5, which this one is stacked on, into a draft: a stack's lower pull requests run no CI")
    expect(ghCalls().filter((c) => c.args[1] === 'ready')).toEqual([])
    const r = await call('open_pr', { ...PR, base: 'feat/low' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain("Turned #5, which this one is stacked on, into a draft: a stack's lower pull requests run no CI")
    expect(r.data.drafted).toBe(5)
    expect(ghCalls().filter((c) => c.args[1] === 'ready').map((c) => c.args)).toEqual([['pr', 'ready', '5', '--undo', '-R', 'ijun17/centralu']])
    // The new one is the top: not a draft
    expect(JSON.parse(writes()[0]!.stdin!).draft).toBe(false)
    // Already a draft, or opened on main: nothing to turn
    for (const base of ['feat/lower-draft', 'main']) {
      const again = await call('open_pr', { ...PR, base })
      expect(again.text).not.toContain('into a draft')
    }
    expect(ghCalls().filter((c) => c.args[1] === 'ready')).toHaveLength(1)
  })

  it('refuses a pull request with an empty Not exercised, a bad title or a heading the template lacks, sending nothing', async () => {
    runtime()
    const empty = await call('open_pr', { ...PR, notExercised: '  ' })
    expect(empty.isError).toBe(true)
    expect(empty.data.problems.join()).toMatch(/"Not exercised" is empty/)
    const na = await call('open_pr', { ...PR, notExercised: 'N/A' })
    expect(na.data.problems.join()).toMatch(/"Not exercised" is only "N\/A"/)
    const title = await call('open_pr', { ...PR, title: 'Add contribution tools' })
    expect(title.data.problems.join()).toMatch(/^Title: The subject "Add contribution tools" is not <type>/)
    const extra = await call('open_pr', { ...PR, sections: { Screenshots: 'x' } })
    expect(extra.data.problems.join()).toMatch(/no heading "Screenshots"/)
    const attribution = await call('open_pr', { ...PR, verified: 'Tests.\n\nCo-Authored-By: Claude <noreply@anthropic.com>' })
    expect(attribution.data.problems.join()).toMatch(/The description carries attribution lines/)
    expect(writes()).toEqual([])
    // dryRun answers the description it would send, and sends nothing
    const dry = await call('open_pr', { ...PR, dryRun: true })
    expect(dry.data.body).toContain('## Not exercised\n\nThe packaged app.')
    expect(writes()).toEqual([])
  })

  it('finds the template where GitHub looks for it, and says what GitHub refused', async () => {
    runtime()
    patchState((s) => {
      s.files['.github/PULL_REQUEST_TEMPLATE.md'] = null
      s.files['docs/PULL_REQUEST_TEMPLATE.md'] = TEMPLATE
      s.prExists = true
    })
    const r = await call('open_pr', PR)
    expect(r.isError).toBe(true)
    expect(r.text).toBe('Not opened: GitHub refused the pull request: Validation Failed (HTTP 422) (A pull request already exists for ijun17:feat/tools.)')
    patchState((s) => (s.files['docs/PULL_REQUEST_TEMPLATE.md'] = null))
    const none = await call('open_pr', { ...PR, base: 'release' })
    expect(none.text).toMatch(/^Not opened: ijun17\/centralu has no pull request template on release to fill/)
  })

  it("checks commit messages against the repository's conventions, read from its default branch", async () => {
    runtime()
    const good = await call('commit_check', { message: 'fix(ui): keep focus\n\nThe caret went missing.' })
    expect(good.isError).toBe(false)
    expect(good.text).toBe('The message follows docs/commit-conventions.md.\n"fix(ui): keep focus": ok')
    expect(good.data.summary).toBe('The message follows docs/commit-conventions.md.')
    const bad = await call('commit_check', { messages: ['Fix focus', 'fix(ui): keep focus\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'fix(ui): added focus'] })
    expect(bad.isError).toBe(true)
    expect(bad.data.results).toEqual([
      '1. "Fix focus": refused',
      '  The subject "Fix focus" is not <type>(<scope>): <description>, for example "fix(ui): keep grid focus on the orchestrator".',
      '2. "fix(ui): keep focus": refused',
      '  The message carries attribution lines ("Co-Authored-By: Claude <noreply@anthropic.com>"). Remove them: nothing here is signed by a tool (docs/commit-conventions.md).',
      '3. "fix(ui): added focus": ok',
      '  (warning) "added" reads as a report; the description is imperative ("add", not "added" or "adds").',
    ])
    // A repository without the document is checked against the usual types, and the answer says so
    patchState((s) => (s.files['docs/commit-conventions.md'] = null))
    const elsewhere = await call('commit_check', { message: 'feat: add a thing', repo: 'someone/else' })
    expect(elsewhere.text).toBe('The message follows the usual Conventional Commits rules (someone/else has no docs/commit-conventions.md).\n"feat: add a thing": ok')
  })
})

// --- rebase_stack, on real repositories ------------------------------------------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text)
  g(cwd, 'add', file)
  g(cwd, 'commit', '-q', '-m', message)
  return g(cwd, 'rev-parse', 'HEAD')
}

type Stack = { work: string; origin: string; c0: string; l1: string; l2: string; u1: string; u2: string; squash: string; mainTip: string }

/**
 * A stack as GitHub leaves it after the lower pull request (#1, branch `low`) was squash-merged:
 * `up` (#2) has `low`'s commits under its own, and main has one squash commit with `low`'s change.
 * `origin.git` stands for GitHub; the checkout's remote is GitHub's address, which git rewrites to it,
 * so the app's check that the remote is ijun17/centralu sees what it sees on a real checkout.
 *
 * - `mainMoves`: main gained a commit before the merge: on another file, on `up`'s own file, or two
 *   lines above a line `up` changes (`near`: replays cleanly, but every diff's context differs)
 * - `stale`: `up` was cut from `low`'s first commit, and `low` got its second one after
 */
function stack({ mainMoves = 'none', stale = false }: { mainMoves?: 'none' | 'other' | 'conflict' | 'near'; stale?: boolean } = {}): Stack {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
  const lines = (changed: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
  writeFileSync(join(work, 'e.txt'), lines())
  g(work, 'add', 'e.txt')
  const c0 = commit(work, 'a.txt', 'a\n', 'base')
  g(work, 'checkout', '-q', '-b', 'low')
  const l1 = commit(work, 'b.txt', '1\n', 'low 1')
  let l2 = ''
  if (!stale) l2 = commit(work, 'b.txt', '1\n2\n', 'low 2')
  g(work, 'checkout', '-q', '-b', 'up')
  const u1 = commit(work, 'c.txt', 'u\n', 'up 1')
  if (mainMoves === 'near') writeFileSync(join(work, 'e.txt'), lines({ 4: 'up changed line 4' }))
  g(work, 'add', 'e.txt')
  const u2 = commit(work, 'c.txt', 'u\nu2\n', 'up 2')
  if (stale) {
    g(work, 'checkout', '-q', 'low')
    l2 = commit(work, 'b.txt', '1\n2\n', 'low 2')
  }
  g(work, 'checkout', '-q', 'main')
  if (mainMoves === 'other') commit(work, 'd.txt', 'd\n', 'main moves')
  if (mainMoves === 'conflict') commit(work, 'c.txt', 'main\n', 'main moves')
  if (mainMoves === 'near') commit(work, 'e.txt', lines({ 2: 'main changed line 2' }), 'main moves')
  g(work, 'merge', '-q', '--squash', 'low')
  g(work, 'commit', '-q', '-m', 'low (#1)')
  const squash = g(work, 'rev-parse', 'HEAD')
  g(work, 'push', '-q', 'origin', 'main', 'low', 'up', `${l2}:refs/pull/1/head`)
  // The person's own work in progress, which nothing here may touch
  g(work, 'checkout', '-q', '-b', 'mine', c0)
  writeFileSync(join(work, 'a.txt'), 'edited, not committed\n')
  writeFileSync(join(work, 'notes.txt'), 'untracked\n')
  patchState((s) => {
    s.prs['1'] = pr(1, { state: 'MERGED', headRefName: 'low', baseRefName: 'main', headRefOid: l2, mergeCommit: { oid: squash } })
    s.prs['2'] = pr(2, { headRefName: 'up', baseRefName: 'low', headRefOid: u2 })
  })
  return { work, origin, c0, l1, l2, u1, u2, squash, mainTip: squash }
}

/** What the person's checkout looks like: its branch, its head, its changes. Must not move. */
const checkout = (work: string) => ({ branch: g(work, 'branch', '--show-current'), head: g(work, 'rev-parse', 'HEAD'), status: g(work, 'status', '--porcelain') })
const leftovers = (work: string) => ({ worktrees: g(work, 'worktree', 'list').split('\n').length, refs: g(work, 'for-each-ref', 'refs/centralu-restack') })

describe('topLevel on a real repository', { timeout: 60_000 * SLOW }, () => {
  const bare = () => {
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    g(root, 'init', '-q', '--bare', '-b', 'main', origin)
    g(root, 'init', '-q', '-b', 'main', work)
    g(work, 'config', 'user.name', 'Tester')
    g(work, 'config', 'user.email', 'tester@example.test')
    g(work, 'config', 'commit.gpgsign', 'false')
    g(work, 'remote', 'add', 'origin', origin)
    commit(work, 'a.txt', 'a\n', 'base')
    return { origin, work }
  }

  it('names the checkout the way the machine writes paths, not the way git does', async () => {
    const { work } = bare()
    expect(await topLevel(work)).toBe(work)
  })
})

describe('rebase_stack', { timeout: 60_000 * SLOW }, () => {
  it('reports a restack without pushing: the change and the tree are the tested ones, and the checkout is untouched', async () => {
    const s = stack()
    const before = checkout(s.work)
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work })
    expect(r.isError).toBe(false)
    expect(r.data.summary).toBe('#2 can be restacked onto main; nothing pushed yet. Call again with push: true to push it (only while up is still ' + s.u2.slice(0, 7) + ') and move its base to main.')
    expect(r.data.steps[0]).toMatch(new RegExp(`^Replayed 2 commits of #2 from ${s.l2.slice(0, 7)} \\(#1's last head\\) onto ${s.squash.slice(0, 7)} \\(#1's merge commit on main\\).*The change is the one tested\\.$`))
    expect(r.data.steps[1]).toBe(`The tree is the tested tree: CI's result for ${s.u2.slice(0, 7)} holds for ${r.data.head.slice(0, 7)}.`)
    expect(r.data).toMatchObject({ pushed: false, sameTree: true })
    expect(g(s.origin, 'rev-parse', 'refs/heads/up')).toBe(s.u2)
    expect(writes()).toEqual([])
    expect(checkout(s.work)).toEqual(before)
    expect(leftovers(s.work)).toEqual({ worktrees: 1, refs: '' })
  })

  it('pushes the restacked branch with a lease, onto the merge commit, and moves the base', async () => {
    const s = stack()
    const before = checkout(s.work)
    runtime()
    const r = await call('rebase_stack', { pr: '#2', path: s.work, push: true })
    expect(r.isError).toBe(false)
    const head = g(s.origin, 'rev-parse', 'refs/heads/up')
    expect(head).toBe(r.data.head)
    expect(g(s.origin, 'rev-parse', `${head}~2`)).toBe(s.squash)
    expect(g(s.origin, 'rev-parse', `${head}^{tree}`)).toBe(g(s.origin, 'rev-parse', `${s.u2}^{tree}`))
    expect(g(s.origin, 'log', '--format=%s', `${s.squash}..${head}`)).toBe('up 2\nup 1')
    expect(r.data.summary).toBe(`#2 restacked onto main at ${head.slice(0, 7)}.`)
    expect(r.data.steps.slice(2)).toEqual([`Pushed ${head.slice(0, 7)} to up on origin, where it was ${s.u2.slice(0, 7)}.`, "Moved #2's base from low to main."])
    expect(writes()).toEqual([{ args: ['api', '-X', 'PATCH', 'repos/ijun17/centralu/pulls/2', '--input', '-'], stdin: '{"base":"main"}' }])
    expect(checkout(s.work)).toEqual(before)
    expect(leftovers(s.work)).toEqual({ worktrees: 1, refs: '' })
  })

  // #1066: a stack's lowers are drafts; restacked onto main with nothing based on it, a draft is its stack's top now
  it('says when the pull request it restacked is a draft nothing is based on any more, so CI runs once it is marked ready', async () => {
    const s = stack()
    patchState((st) => (st.prs['2']!.isDraft = true))
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work, push: true })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.steps.at(-1)).toBe("#2 is a draft, and no open pull request is based on up: if it is its stack's top now, mark it ready for review (mark_ready, or gh pr ready 2) so CI runs on it.")
  })

  it('says nothing of a draft it restacked that is still a lower of another', async () => {
    const t = stack()
    runtime()
    patchState((st) => {
      st.prs['2']!.isDraft = true
      st.prs['3'] = pr(3, { headRefName: 'top', baseRefName: 'up' })
    })
    const again = await call('rebase_stack', { pr: 2, path: t.work, push: true })
    expect(again.data.steps.join(' ')).not.toContain('is a draft')
  })

  it('says when the tree differs from the tested one, and that the difference is only what main had', async () => {
    const s = stack({ mainMoves: 'other' })
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work })
    expect(r.isError).toBe(false)
    expect(r.data.sameTree).toBe(false)
    expect(r.data.steps[1]).toBe(
      `The tree is not the tested tree: it differs in 1 file (d.txt), exactly what main had at the merge that #1's last head did not. CI has to pass on ${r.data.head.slice(0, 7)} before it is merged.`,
    )
  })

  it('takes a change whose neighbouring lines main changed as the same change, and says the tree differs there', async () => {
    const s = stack({ mainMoves: 'near' })
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work })
    expect(r.isError).toBe(false)
    expect(r.data.steps[0]).toMatch(/The change is the one tested\.$/)
    expect(r.data.steps[1]).toMatch(/^The tree is not the tested tree: it differs in 1 file \(e\.txt\), exactly what main had at the merge that #1's last head did not\./)
  })

  /*
   * The 2026-10-05 mistake: the lower pull request changed after the upper one was cut from it, so
   * the commit to replay from was not in the upper branch any more. Replaying anyway would carry the
   * lower one's old commits along.
   */
  it('refuses a pull request built on an older version of the one under it, and pushes nothing', async () => {
    const s = stack({ stale: true })
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work, push: true })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(
      `Not restacked: #2 (${s.u2.slice(0, 7)}) does not contain #1's last head ${s.l2.slice(0, 7)}: it was built on an older version of #1, which changed after. Replaying from here would carry #1's old commits along. Rebase up onto ${s.l2.slice(0, 7)} by hand first, or redo it on main.`,
    )
    expect(g(s.origin, 'rev-parse', 'refs/heads/up')).toBe(s.u2)
    expect(writes()).toEqual([])
  })

  it('refuses when replaying conflicts, aborts, and leaves no worktree behind', async () => {
    const s = stack({ mainMoves: 'conflict' })
    runtime()
    const r = await call('rebase_stack', { pr: 2, path: s.work, push: true })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(`Not restacked: Replaying #2's 2 commits on #1's merge commit ${s.squash.slice(0, 7)} conflicts in c.txt. Nothing was pushed; resolve it by hand.`)
    expect(g(s.origin, 'rev-parse', 'refs/heads/up')).toBe(s.u2)
    expect(leftovers(s.work)).toEqual({ worktrees: 1, refs: '' })
  })

  it('refuses while the one under it is not merged, or when the branch moved after GitHub was read', async () => {
    const s = stack()
    runtime()
    patchState((st) => (st.prs['1']!.state = 'OPEN'))
    expect((await call('rebase_stack', { pr: 2, path: s.work })).text).toBe('Not restacked: #1 (low) is not merged yet (open); restack #2 after it is.')
    patchState((st) => {
      st.prs['1']!.state = 'MERGED'
      st.prs['2']!.headRefOid = s.u1
    })
    expect((await call('rebase_stack', { pr: 2, path: s.work })).text).toBe(
      `Not restacked: #2's branch up is at ${s.u2.slice(0, 7)} on origin, but GitHub reported ${s.u1.slice(0, 7)}: it moved while this ran. Call again.`,
    )
  })

  it('needs lower once GitHub moved the base itself, and then leaves the base alone', async () => {
    const s = stack()
    runtime()
    patchState((st) => (st.prs['2']!.baseRefName = 'main'))
    const lost = await call('rebase_stack', { pr: 2, path: s.work })
    expect(lost.text).toMatch(/^Not restacked: #2 is not stacked: its base main is not the branch of a pull request\. .* name that one with lower\.$/)
    const r = await call('rebase_stack', { pr: 2, lower: 1, path: s.work, push: true })
    expect(r.isError).toBe(false)
    expect(r.data.steps.at(-1)).toBe("#2's base is already main.")
    expect(writes()).toEqual([])
  })

  it('refuses a checkout with no remote for the repository', async () => {
    const s = stack()
    g(s.work, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git')
    runtime()
    expect((await call('rebase_stack', { pr: 2, path: s.work })).text).toBe(`Not restacked: The checkout at ${s.work} has no remote for github.com/ijun17/centralu. Give path: a checkout of it.`)
  })
})

// --- open_pr runs pnpm pre-pr first (#1181) --------------------------------------------------------

/**
 * A checkout whose remote is GitHub's address, rewritten to a bare repository made here (as for
 * rebase_stack), with a scripts/pre-pr.mjs standing for the repository's: it records how it was
 * called and which of the board's refs it saw, and answers what the test put in pre-pr-answer.json.
 */
function prePrCheckout() {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
  commit(work, 'a.txt', 'a\n', 'base')
  g(work, 'checkout', '-q', '-b', 'feat/low')
  const low = commit(work, 'b.txt', 'b\n', 'low')
  g(work, 'checkout', '-q', '-b', 'feat/tools')
  const tools = commit(work, 'c.txt', 'c\n', 'tools')
  g(work, 'push', '-q', 'origin', 'main', 'feat/low', 'feat/tools')
  g(work, 'checkout', '-q', 'main')
  mkdirSync(join(work, 'scripts'))
  writeFileSync(
    join(work, 'scripts/pre-pr.mjs'),
    [
      "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { execFileSync, spawn } from 'node:child_process'",
      "const refs = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/centralu-pre-pr'], { encoding: 'utf8' }).trim().split('\\n')",
      "appendFileSync(new URL('../../pre-pr-calls.jsonl', import.meta.url), JSON.stringify({ args: process.argv.slice(2), refs }) + '\\n')",
      "const answer = new URL('../../pre-pr-answer.json', import.meta.url)",
      "const hang = existsSync(answer) ? JSON.parse(readFileSync(answer, 'utf8')).hangMs : 0",
      "if (hang && !process.argv.includes('--cleanup')) {",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "  writeFileSync(new URL('../../pre-pr-grandchild.pid', import.meta.url), String(child.pid))",
      "  await new Promise((r) => setTimeout(r, hang))",
      "  child.kill()",
      "}",
      "process.stdout.write('progress on stdout\\n' + (existsSync(answer) ? readFileSync(answer, 'utf8') : 'not json') + '\\n')",
    ].join('\n'),
  )
  return { work, low, tools }
}
const prePrCalls = () => (existsSync(join(root, 'pre-pr-calls.jsonl')) ? readFileSync(join(root, 'pre-pr-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; refs: string[] }) : [])
const prePrAnswers = (a: unknown) => writeFileSync(join(root, 'pre-pr-answer.json'), JSON.stringify(a))
/** The refs a call fetched under: refs/centralu-pre-pr/<one of its own>, read from its --head */
const spaceOf = (args: string[]) => /^(refs\/centralu-pre-pr\/[^/]+)\/feat\/tools$/.exec(args[args.indexOf('--head') + 1]!)![1]!
const PR_PLAIN = {
  title: 'feat(apps): add contribution tools to the board',
  head: 'feat/tools',
  why: 'Procedure errors.',
  whatChanged: 'Tools.',
  verified: 'Tests.',
  situationsChecked: 'Two at once: each call opens its own.',
  usability: 'n/a',
  notExercised: 'The packaged app.',
  closes: 'Refs #386',
}

describe('open_pr runs pnpm pre-pr before it opens anything', { timeout: 60_000 * SLOW }, () => {
  it('refuses with what pre-pr found, sending nothing, on the pushed head fetched under refs of its own', async () => {
    const c = prePrCheckout()
    prePrAnswers({ ok: false, findings: [{ check: 'revert', message: 'a.test.ts: "x" passes without the change' }, { check: 'tsc', message: 'tsc fails at feat/low' }], notes: ['1 test fails without the change'], heads: [], head: c.tools })
    const tracking = g(c.work, 'for-each-ref', 'refs/remotes')
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(r.isError).toBe(true)
    expect(r.text).toBe(
      'Not opened: pnpm pre-pr found 2 problem(s) on feat/tools; nothing was sent to GitHub. Fix them and push, or give prePrExempt (one check) or skipPrePr (all) with the reason they stand.\n' +
        '[revert] a.test.ts: "x" passes without the change\n[tsc] tsc fails at feat/low\nNotes:\n1 test fails without the change',
    )
    expect(writes()).toEqual([])
    const [run] = prePrCalls()
    const ns = spaceOf(run!.args)
    expect(run!.args).toEqual(['--json', '--no-fetch', '--run-id', ns.split('/').pop(), '--remote', 'origin', '--head', `${ns}/feat/tools`, '--base', `${ns}/main`, '--main', `${ns}/main`])
    expect(run!.refs).toContain(`${ns}/feat/tools ${c.tools}`)
    // A second call fetches under another name: one call's clean-up never deletes what the other reads
    await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(spaceOf(prePrCalls()[1]!.args)).not.toBe(ns)
    // Nothing of the person's moved: the board's refs are gone, and the remote-tracking refs are as they were
    expect(g(c.work, 'for-each-ref', 'refs/centralu-pre-pr')).toBe('')
    expect(g(c.work, 'for-each-ref', 'refs/remotes')).toBe(tracking)
  })

  it('checks every pull request under a stacked one, and says in Verified that it passed', async () => {
    const c = prePrCheckout()
    patchState((s) => (s.prs['5'] = pr(5, { headRefName: 'feat/low', baseRefName: 'main' })))
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [{ sha: c.low }, { sha: c.tools }], head: c.tools })
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, base: 'feat/low', path: c.work })
    expect(r.isError, r.text).toBe(false)
    const args = prePrCalls()[0]!.args
    const ns = spaceOf(args)
    expect(args).toEqual(['--json', '--no-fetch', '--run-id', ns.split('/').pop(), '--remote', 'origin', '--head', `${ns}/feat/tools`, '--base', `${ns}/feat/low`, '--main', `${ns}/main`, '--stack', `${ns}/feat/low`])
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain(`## Verified\n\nTests.\n\n\`pnpm pre-pr\` passed at ${c.tools.slice(0, 10)}: tsc at 2 head(s), no orphans, no new test passes without the change.`)
  })

  it('writes the tier pre-pr answers into Verified and labels the pull request with it (#1259)', async () => {
    const c = prePrCheckout()
    const line = 'Tier: deep, from `packages/protocol/src/a.ts` (protocol); the other files: 1 auto.'
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [{ sha: c.tools }], head: c.tools, tier: { name: 'deep', line, because: ['packages/protocol/src/a.ts'] } })
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('Labelled tier:deep.')
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain(`no new test passes without the change.\n${line}`)
    const label = writes().find((w) => w.args[3] === 'repos/ijun17/centralu/issues/900/labels')!
    expect(JSON.parse(label.stdin!)).toEqual({ labels: ['tier:deep'] })
  })

  it('opens the pull request when GitHub refuses the tier label, and says how to add it', async () => {
    const c = prePrCheckout()
    patchState((s) => (s.labelsRefused = true))
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [{ sha: c.tools }], head: c.tools, tier: { name: 'light', line: 'Tier: light, from `a.ts` (no rule matches: light).', because: ['a.ts'] } })
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toMatch(/^Opened #900 /)
    expect(r.text).toContain('Add the label yourself: gh pr edit 900 --add-label tier:light.')
  })

  it('opens without it only with a stated reason, which goes into Verified', async () => {
    const c = prePrCheckout()
    prePrAnswers({ ok: false, findings: [{ check: 'tsc', message: 'x' }], notes: [], heads: [], head: c.tools })
    runtime()
    const blank = await call('open_pr', { ...PR_PLAIN, path: c.work, skipPrePr: '  ' })
    expect(blank.text).toBe('Not opened: skipPrePr needs the reason the checks are skipped; it goes into the description.')
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work, skipPrePr: 'The new test guards a Windows path that this branch only documents.' })
    expect(r.isError, r.text).toBe(false)
    expect(prePrCalls()).toEqual([])
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain('Tests.\n\n`pnpm pre-pr` was not run: The new test guards a Windows path that this branch only documents.')
    // Not judged, so deep: skipping pre-pr never lowers the review (#1259)
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain('only documents.\nTier: deep (pnpm pre-pr was not run, so the paths were not judged).')
    expect(JSON.parse(writes().find((w) => w.args[3] === 'repos/ijun17/centralu/issues/900/labels')!.stdin!)).toEqual({ labels: ['tier:deep'] })
  })

  it('labels deep when pre-pr answers no tier (#1259)', async () => {
    const c = prePrCheckout()
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [{ sha: c.tools }], head: c.tools })
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(r.isError, r.text).toBe(false)
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain('Tier: deep (pnpm pre-pr answered no tier, so the paths were not judged).')
    expect(JSON.parse(writes().find((w) => w.args[3] === 'repos/ijun17/centralu/issues/900/labels')!.stdin!)).toEqual({ labels: ['tier:deep'] })
  })

  it('refuses a bad title before spending minutes on pre-pr, and says when pre-pr could not run', async () => {
    const c = prePrCheckout()
    runtime()
    const title = await call('open_pr', { ...PR_PLAIN, title: 'Add tools', path: c.work })
    expect(title.data.problems.join()).toMatch(/^Title: The subject "Add tools" is not <type>/)
    expect(prePrCalls()).toEqual([])
    // No answer file: the script prints no JSON
    const broken = await call('open_pr', { ...PR_PLAIN, path: c.work })
    expect(broken.isError).toBe(true)
    expect(broken.text).toMatch(/^Not opened: pnpm pre-pr did not run: scripts\/pre-pr\.mjs could not check: .*Give path \(a checkout of ijun17\/centralu\), or skipPrePr with the reason it cannot run\.$/)
    const fork = await call('open_pr', { ...PR_PLAIN, head: 'someone:feat/tools', path: c.work })
    expect(fork.text).toMatch(/^Not opened: pnpm pre-pr cannot fetch a fork's branch \(someone:feat\/tools\) here/)
    expect(writes()).toEqual([])
  })
})

describe('open_pr\'s pre-pr: exemptions, warnings, cancellation and time', { timeout: 120_000 * SLOW }, () => {
  const grandchild = () => (existsSync(join(root, 'pre-pr-grandchild.pid')) ? Number(readFileSync(join(root, 'pre-pr-grandchild.pid'), 'utf8')) : 0)
  // What the test has seen end is not signalled afterwards: its number may be someone else's by then (#1308)
  let own = ownProcesses()
  const isAlive = (pid: number) => own.alive(pid)
  const until = async (what: string, ok: () => boolean, ms = 30_000 * SLOW) => {
    const end = Date.now() + ms
    while (!ok()) {
      if (Date.now() > end) throw new Error(`still waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  afterEach(() => {
    // A grandchild a failed test left running is the test's own process: stop it by its id, unless the test saw it end
    own.end([grandchild()], { signal: 'SIGTERM' })
    own = ownProcesses()
  })

  it('leaves out one check with its reason, and opens with a warning instead of refusing a branch behind main', async () => {
    const c = prePrCheckout()
    prePrAnswers({
      ok: true, findings: [], notes: [], heads: [{ sha: c.tools }], head: c.tools,
      warnings: [{ check: 'main', message: 'feat/tools does not contain main: 1 commit(s) behind.' }],
      exempted: [{ check: 'revert', reason: 'The new test guards a Windows path this branch only documents.' }],
    })
    runtime()
    const blank = await call('open_pr', { ...PR_PLAIN, path: c.work, prePrExempt: { revert: ' ' } })
    expect(blank.text).toBe('Not opened: prePrExempt.revert needs the reason that check is left out; it goes into the description.')
    const unknown = await call('open_pr', { ...PR_PLAIN, path: c.work, prePrExempt: { main: 'x' } })
    expect(unknown.isError).toBe(true)
    expect(prePrCalls()).toEqual([])
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work, prePrExempt: { revert: 'The new test guards a Windows path this branch only documents.' } })
    expect(r.isError, r.text).toBe(false)
    expect(prePrCalls()[0]!.args.slice(-2)).toEqual(['--exempt', 'revert=The new test guards a Windows path this branch only documents.'])
    expect(r.data.warnings).toEqual(['[main] feat/tools does not contain main: 1 commit(s) behind.'])
    expect(JSON.parse(writes()[0]!.stdin!).body).toContain(
      `Tests.\n\n\`pnpm pre-pr\` passed at ${c.tools.slice(0, 10)}: tsc at 1 head(s), no orphans.\nNot run, the revert check: The new test guards a Windows path this branch only documents.\nWarning (main): feat/tools does not contain main: 1 commit(s) behind.`,
    )
  })

  it('passes an exemption from the store step check on to pre-pr', async () => {
    const c = prePrCheckout()
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [{ sha: c.tools }], head: c.tools, warnings: [], exempted: [{ check: 'store-step', reason: 'Number 60 was assigned to this branch.' }] })
    runtime()
    const r = await call('open_pr', { ...PR_PLAIN, path: c.work, prePrExempt: { 'store-step': 'Number 60 was assigned to this branch.' } })
    expect(r.isError, r.text).toBe(false)
    expect(prePrCalls()[0]!.args.slice(-2)).toEqual(['--exempt', 'store-step=Number 60 was assigned to this branch.'])
  })

  it('opens nothing when the call is cancelled, and stops pre-pr\'s whole process tree and cleans up after it', async () => {
    const c = prePrCheckout()
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [], head: c.tools, hangMs: 60_000 })
    runtime()
    const abort = new AbortController()
    const outcome = rt!.call(ref, 'open_pr', { ...PR_PLAIN, path: c.work }, agent, { signal: abort.signal })
    await until('pre-pr to start its own child', () => grandchild() > 0)
    abort.abort()
    await outcome
    await until('the clean-up run', () => prePrCalls().some((x) => x.args[0] === '--cleanup'))
    const [run, cleanup] = prePrCalls()
    expect(cleanup!.args).toEqual(['--cleanup', run!.args[run!.args.indexOf('--run-id') + 1]])
    await until('the grandchild to be stopped', () => !isAlive(grandchild()))
    // Long after pre-pr would have answered "passed", still nothing was opened
    await new Promise((r) => setTimeout(r, 1_500))
    expect(writes()).toEqual([])
    await until('the refs to go', () => g(c.work, 'for-each-ref', 'refs/centralu-pre-pr') === '')
  })

  it('stops pre-pr when it runs out of time, and says a ref it could not remove instead of swallowing it', async () => {
    // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
    const { runPrePr } = await import('../.centralu/apps/project-board/pre-pr.mjs')
    const c = prePrCheckout()
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [], head: c.tools, hangMs: 60_000 })
    const late = await runPrePr({ dir: c.work, repo: 'ijun17/centralu', head: 'feat/tools', base: 'main', main: 'main', limitMs: 3_000 })
    expect(late.ran).toBe(false)
    expect(late.why).toBe('it was stopped: it did not finish within 3 s.')
    await until('the grandchild to be stopped', () => !isAlive(grandchild()))
    expect(prePrCalls().at(-1)!.args[0]).toBe('--cleanup')

    // A ref locked while pre-pr runs cannot be deleted after: the answer names it
    prePrAnswers({ ok: true, findings: [], notes: [], heads: [], head: c.tools, hangMs: 2_000 })
    const answered = runPrePr({ dir: c.work, repo: 'ijun17/centralu', head: 'feat/tools', base: 'main', main: 'main' })
    await until('pre-pr to start', () => prePrCalls().length === 3)
    const head = prePrCalls()[2]!.args[prePrCalls()[2]!.args.indexOf('--head') + 1]!
    const lock = join(c.work, '.git', `${head}.lock`)
    writeFileSync(lock, '')
    const r = await answered
    rmSync(lock)
    expect(r.ran).toBe(true)
    expect(r.refsLeft).toHaveLength(1)
    expect(r.refsLeft[0]).toMatch(new RegExp(`^${head.replace(/[/-]/g, '\\$&')} \\(.*\\); remove it with git update-ref -d `))
  })
})
