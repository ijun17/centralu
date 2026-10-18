import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script the workflow runs with the runner's own Node
import { ARTIFACT, findMainArtifact } from '../.github/scripts/bundle-base.mjs'
// @ts-expect-error — plain .mjs, shared with that script
import { BUNDLE_ALLOWANCE, BUNDLE_CEILING, GROWTH_DIR, jsBytesOf, judgeBundle, readBundleBase, readDeclarations, writeBundleRecord } from './bundle-budget.mjs'

type Declaration = { name: string; bytes: number; reason: string }
const MAIN = 1_790_000
const record = (declared: string[] = [], bytes = MAIN) => ({ record: { bytes, sha: 'c63b2867aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', declared, measured: false } })
const decl = (name: string, bytes: number): Declaration => ({ name, bytes, reason: `${name} grows it` })
const judge = (bytes: number, base: unknown, declarations: Declaration[] = [], required = true) => judgeBundle({ bytes, base, declarations, required })

describe('the app\'s JS is judged against main\'s plus an allowance, and under a ceiling', () => {
  // Every step across the allowance's edge, and a shrink
  it.each([
    [-50_000, true],
    [0, true],
    [BUNDLE_ALLOWANCE - 1, true],
    [BUNDLE_ALLOWANCE, true],
    [BUNDLE_ALLOWANCE + 1, false],
    [BUNDLE_ALLOWANCE * 3, false],
  ])('growing by %i B passes: %s', (grew, ok) => {
    expect(judge(MAIN + grew, record()).ok).toBe(ok)
  })

  it('tells a change over the allowance what grew, against which commit, and how to declare it', () => {
    const v = judge(MAIN + BUNDLE_ALLOWANCE + 12_345, record())
    expect(v.problems).toHaveLength(1)
    expect(v.problems[0]).toContain(`+${BUNDLE_ALLOWANCE + 12_345} B against main's ${MAIN} B (c63b2867)`)
    // Rounded up to whole kilobytes, so the number written passes
    expect(v.problems[0]).toContain(`add ${GROWTH_DIR}/<your-branch>.json in this pull request: { "bytes": 13000, "reason":`)
  })

  it('lets a new declaration add its bytes, and no more', () => {
    const at = MAIN + BUNDLE_ALLOWANCE + 13_000
    expect(judge(at, record(), [decl('viewer.json', 13_000)]).ok).toBe(true)
    expect(judge(at + 1, record(), [decl('viewer.json', 13_000)]).ok).toBe(false)
  })

  it('counts a declaration once: main\'s record that lists it already holds its bytes', () => {
    const declared = [decl('viewer.json', 13_000)]
    expect(judge(MAIN + BUNDLE_ALLOWANCE + 1, record(['viewer.json']), declared).ok).toBe(false)
    expect(judge(MAIN + BUNDLE_ALLOWANCE, record(['viewer.json']), declared).ok).toBe(true)
  })

  // A merge-queue batch is one change against main: two pull requests landing together
  it('passes a batch of two declaring pull requests on both declarations, each once', () => {
    const both = [decl('a.json', 40_000), decl('b.json', 50_000)]
    expect(judge(MAIN + BUNDLE_ALLOWANCE + 90_000, record(), both).ok).toBe(true)
    expect(judge(MAIN + BUNDLE_ALLOWANCE + 90_001, record(), both).ok).toBe(false)
  })

  it('does not grant a landed declaration again to the next batch, before or after main\'s record catches up', () => {
    // a.json landed in main's last push; main's record has it, so a batch carrying b.json gets b's bytes only
    const both = [decl('a.json', 40_000), decl('b.json', 50_000)]
    const after = MAIN + 40_000
    expect(judge(after + BUNDLE_ALLOWANCE + 50_000, record(['a.json'], after), both).ok).toBe(true)
    expect(judge(after + BUNDLE_ALLOWANCE + 50_001, record(['a.json'], after), both).ok).toBe(false)
    // Main's record still from before a.json landed: a's growth is not in its bytes yet, so a's bytes count, once
    expect(judge(after + BUNDLE_ALLOWANCE + 50_000, record([], MAIN), both).ok).toBe(true)
    expect(judge(after + BUNDLE_ALLOWANCE + 50_001, record([], MAIN), both).ok).toBe(false)
  })

  it('holds the ceiling against many changes under the allowance, and lets only declarations raise it', () => {
    // main crept up to the ceiling; one more ordinary change passes against main but not the ceiling
    const v = judge(BUNDLE_CEILING + 1, record([], BUNDLE_CEILING - 10_000))
    expect(v.ok).toBe(false)
    expect(v.problems[0]).toContain(`over the ceiling of ${BUNDLE_CEILING} B`)
    expect(judge(BUNDLE_CEILING + 1, record(['old.json'], BUNDLE_CEILING - 10_000), [decl('old.json', 1_000)]).ok).toBe(true)
    // Without any record, the ceiling still holds (a local run)
    expect(judge(BUNDLE_CEILING + 1, null, [], false).ok).toBe(false)
  })

  it('fails when the comparison is required and main\'s record is missing or unreadable, naming why', () => {
    const v = judge(MAIN, { missing: 'GitHub did not answer' })
    expect(v.ok).toBe(false)
    expect(v.problems[0]).toBe(`The app's JS (${MAIN} B) could not be compared with main's: GitHub did not answer. Run the job again once main's verify job has uploaded its bundle-size record.`)
    expect(judge(MAIN, null).problems[0]).toContain("no record of main's bundle was fetched")
    // Outside CI it is a note, not a failure
    const local = judge(MAIN, null, [], false)
    expect(local.ok).toBe(true)
    expect(local.notes[0]).toContain('not compared with main')
  })
})

describe('the record and the declarations on disk', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const at = (...parts: string[]) => {
    dir ||= mkdtempSync(join(tmpdir(), 'cc-bundle-budget-'))
    return join(dir, ...parts)
  }

  it('writes a record the next run reads back', () => {
    writeBundleRecord(at('rec'), { bytes: 1_234_567, sha: 'abc', declared: ['a.json'] })
    expect(readBundleBase(at('rec'))).toEqual({ record: { bytes: 1_234_567, sha: 'abc', declared: ['a.json'], measured: false } })
    expect(readFileSync(at('rec', 'bundle-size.json'), 'utf8').endsWith('\n')).toBe(true)
  })

  it('says why there is no record: the fetch step\'s reason, an unreadable file, or nothing fetched at all', () => {
    mkdirSync(at('a'), { recursive: true })
    writeFileSync(at('a', 'missing.txt'), 'no run of main has one\n')
    expect(readBundleBase(at('a'))).toEqual({ missing: 'no run of main has one' })
    mkdirSync(at('b'))
    writeFileSync(at('b', 'bundle-size.json'), '{"bytes":"big"}')
    expect(readBundleBase(at('b')).missing).toMatch(/is not a bundle record/)
    writeFileSync(at('b', 'bundle-size.json'), '<html>')
    expect(readBundleBase(at('b')).missing).toMatch(/is not JSON/)
    expect(readBundleBase(at('none'))).toEqual({ missing: null })
  })

  it('reads every declaration in its folder, sorted, and refuses one that says nothing usable', () => {
    expect(readDeclarations(at())).toEqual([])
    mkdirSync(at(GROWTH_DIR), { recursive: true })
    writeFileSync(at(GROWTH_DIR, 'b.json'), '{"bytes":2000,"reason":"  b  "}')
    writeFileSync(at(GROWTH_DIR, 'a.json'), '{"bytes":1000,"reason":"a"}')
    writeFileSync(at(GROWTH_DIR, 'notes.md'), 'not a declaration')
    expect(readDeclarations(at())).toEqual([{ name: 'a.json', bytes: 1000, reason: 'a' }, { name: 'b.json', bytes: 2000, reason: 'b' }])
    for (const bad of ['{"bytes":5000}', '{"bytes":5000,"reason":" "}', '{"bytes":0,"reason":"x"}', '{"bytes":1.5,"reason":"x"}', '[]']) {
      writeFileSync(at(GROWTH_DIR, 'c.json'), bad)
      expect(() => readDeclarations(at())).toThrow(`${GROWTH_DIR}/c.json must be`)
    }
  })

  it('counts the JS files of a build, and nothing else', () => {
    mkdirSync(at('assets'), { recursive: true })
    writeFileSync(at('assets', 'a.js'), 'x'.repeat(10))
    writeFileSync(at('assets', 'b.js'), 'x'.repeat(5))
    writeFileSync(at('assets', 'c.css'), 'x'.repeat(100))
    expect(jsBytesOf(at('assets'))).toBe(15)
  })
})

describe('CI finds main\'s record among main\'s own runs, page by page', () => {
  const run = (id: number, over: Record<string, unknown> = {}) => ({ id, head_branch: 'main', head_sha: `s${id}`, created_at: `2026-10-18T10:${String(id).padStart(2, '0')}:00Z`, repository: { id: 7 }, head_repository: { id: 7 }, ...over })
  const art = (over: Record<string, unknown> = {}) => ({ name: ARTIFACT, expired: false, ...over })
  /** A fake GitHub: `pages` of runs, and each run's artifacts */
  function api(pages: unknown[][], artifacts: Record<number, unknown[]>) {
    const asked: string[] = []
    const answer = (path: string) => {
      asked.push(path)
      const page = /[?&]page=(\d+)/.exec(path)
      if (path.startsWith('actions/workflows/build.yml/runs?')) return { workflow_runs: pages[Number(page![1]) - 1] ?? [] }
      const id = Number(/actions\/runs\/(\d+)\/artifacts/.exec(path)![1])
      return { artifacts: artifacts[id] ?? [] }
    }
    return { answer, asked }
  }
  const full = (from: number) => Array.from({ length: 50 }, (_, i) => run(from + i, { created_at: `2026-10-${String(17 - Math.floor(i / 40)).padStart(2, '0')}T00:00:00Z` }))

  it('asks only main\'s push runs, and pages past runs that have no record', () => {
    const g = api([full(100), [run(200)]], { 200: [art()] })
    const found = findMainArtifact(g.answer)
    expect(found.run.id).toBe(200)
    expect(g.asked[0]).toBe('actions/workflows/build.yml/runs?branch=main&event=push&per_page=50&page=1')
    expect(g.asked).toContain('actions/workflows/build.yml/runs?branch=main&event=push&per_page=50&page=2')
  })

  it('takes the newest run that has one, whatever order a page came in', () => {
    const g = api([[run(1), run(3), run(2)]], { 1: [art()], 2: [art()], 3: [art()] })
    expect(findMainArtifact(g.answer).run.id).toBe(3)
  })

  it.each([
    ['a fork\'s branch named main', run(9, { head_repository: { id: 8 } }), { 9: [art()] }],
    ['an expired record', run(9), { 9: [art({ expired: true })] }],
    ['another artifact', run(9), { 9: [art({ name: 'centralu-linux-x64' })] }],
  ])('passes over %s', (_, skipped, artifacts) => {
    const g = api([[{ ...skipped, created_at: '2026-10-19T00:00:00Z' }, run(1)]], { ...artifacts, 1: [art()] })
    expect(findMainArtifact(g.answer).run.id).toBe(1)
  })

  it('answers nothing when no run of main has a record, after the pages it reads', () => {
    const g = api([full(100), full(200), full(300), full(400), full(500), full(600), full(700)], {})
    expect(findMainArtifact(g.answer)).toBeNull()
    expect(g.asked.filter((p) => p.includes('/runs?'))).toHaveLength(6)
  })

  it('wires verify: fetch main\'s record, compare in pnpm verify, upload this run\'s even when verify failed', () => {
    const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
    const verify = workflow.split(/^ {2}verify:\n/m)[1]!.split(/^ {2}\S/m)[0]!
    const fetch = verify.indexOf('run: node .github/scripts/bundle-base.mjs "$RUNNER_TEMP/bundle-base"')
    const run = verify.indexOf('- run: pnpm verify')
    const upload = verify.indexOf(`name: ${ARTIFACT}\n`)
    expect(fetch).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(fetch)
    expect(upload).toBeGreaterThan(run)
    expect(verify).toContain('CC_BUNDLE_BASE: ${{ runner.temp }}/bundle-base\n')
    expect(verify).toContain('CC_BUNDLE_RECORD: ${{ runner.temp }}/bundle-size\n')
    expect(verify.slice(run, upload + 200)).toContain("if: ${{ !cancelled() }}")
    // The other job running styles.test.ts in CI says which job compares, rather than skipping quietly
    expect(workflow.split(/^ {2}windows-tests-unit:\n/m)[1]!.split(/^ {2}\S/m)[0]).toContain('CC_BUNDLE_COMPARED_BY: verify')
  })
})
