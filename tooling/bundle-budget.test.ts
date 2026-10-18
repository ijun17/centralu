import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script the workflow runs with the runner's own Node
import { ARTIFACT, pickMainArtifact } from '../.github/scripts/bundle-base.mjs'
import { BUNDLE_ALLOWANCE, GROWTH_FILE, judgeBundle, readBundleRecord, readGrowthDeclaration, writeBundleRecord } from './bundle-budget.js'

const BASE = { bytes: 1_790_000, sha: 'c63b2867aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', growth: null }

describe('the app\'s JS is judged against main\'s, plus an allowance', () => {
  it('does not compare without a record of main, and says so', () => {
    const v = judgeBundle({ bytes: 1_900_000, base: null, declared: null })
    expect(v.kind).toBe('no-base')
    expect(v.note).toContain('1900000 B')
  })

  // Every step across the allowance's edge, and a shrink
  it.each([
    [-50_000, 'within'],
    [0, 'within'],
    [BUNDLE_ALLOWANCE - 1, 'within'],
    [BUNDLE_ALLOWANCE, 'within'],
    [BUNDLE_ALLOWANCE + 1, 'over'],
    [BUNDLE_ALLOWANCE * 3, 'over'],
  ])('growing by %i B is %s', (grew, kind) => {
    const v = judgeBundle({ bytes: BASE.bytes + grew, base: BASE, declared: null })
    expect(v.kind).toBe(kind)
    expect(v.kind === 'no-base' ? 0 : v.limit).toBe(BASE.bytes + BUNDLE_ALLOWANCE)
  })

  it('tells a change over the allowance what grew, against which commit, and how to declare it', () => {
    const v = judgeBundle({ bytes: BASE.bytes + BUNDLE_ALLOWANCE + 12_345, base: BASE, declared: null })
    expect(v.kind).toBe('over')
    expect(v.note).toContain(`+${BUNDLE_ALLOWANCE + 12_345} B against main's 1790000 B (c63b2867)`)
    expect(v.note).toContain(GROWTH_FILE)
    // Rounded up to whole kilobytes, so the number written passes
    expect(v.note).toContain('{ "bytes": 13000, "reason":')
  })

  it('lets a declaration add its bytes to the allowance, and no more', () => {
    const declared = { bytes: 13_000, reason: 'the terminal renderer' }
    const at = BASE.bytes + BUNDLE_ALLOWANCE + 13_000
    expect(judgeBundle({ bytes: at, base: BASE, declared }).kind).toBe('within')
    expect(judgeBundle({ bytes: at + 1, base: BASE, declared }).kind).toBe('over')
    expect(judgeBundle({ bytes: at, base: BASE, declared }).note).toContain(`declared in ${GROWTH_FILE}`)
  })

  it('treats a declaration main\'s record already carries as spent', () => {
    const declared = { bytes: 13_000, reason: 'the terminal renderer' }
    const base = { ...BASE, growth: 'the terminal renderer' }
    // The growth it declared is in main's bytes now; the next change gets the plain allowance
    expect(judgeBundle({ bytes: BASE.bytes + BUNDLE_ALLOWANCE + 1, base, declared }).kind).toBe('over')
    expect(judgeBundle({ bytes: BASE.bytes + BUNDLE_ALLOWANCE, base, declared }).kind).toBe('within')
  })
})

describe('the record and the declaration on disk', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const at = (name: string, text?: string) => {
    dir ||= mkdtempSync(join(tmpdir(), 'cc-bundle-budget-'))
    const path = join(dir, name)
    if (text !== undefined) writeFileSync(path, text)
    return path
  }

  it('reads no record when there is no file or no path', () => {
    expect(readBundleRecord(undefined)).toBeNull()
    expect(readBundleRecord(at('none.json'))).toBeNull()
  })

  it('writes a record the next run reads back', () => {
    const path = join(at('x'), '..', 'nested', 'bundle-size.json')
    writeBundleRecord(path, { bytes: 1_234_567, sha: 'abc', growth: 'why' })
    expect(readBundleRecord(path)).toEqual({ bytes: 1_234_567, sha: 'abc', growth: 'why' })
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
  })

  it('refuses a record without a size, rather than comparing with nothing', () => {
    expect(() => readBundleRecord(at('bad.json', '{"bytes":"big"}'))).toThrow(/not a bundle record/)
  })

  it('reads no declaration when the file is absent, and a trimmed one when present', () => {
    expect(readGrowthDeclaration(at('absent.json'))).toBeNull()
    expect(readGrowthDeclaration(at('ok.json', '{"bytes":5000,"reason":"  a new viewer  "}'))).toEqual({ bytes: 5000, reason: 'a new viewer' })
  })

  it.each(['{"bytes":5000}', '{"bytes":5000,"reason":" "}', '{"bytes":0,"reason":"x"}', '{"bytes":1.5,"reason":"x"}', '[]'])(
    'refuses a declaration that says nothing usable: %s',
    (text) => {
      expect(() => readGrowthDeclaration(at('d.json', text))).toThrow(GROWTH_FILE)
    },
  )
})

describe('CI finds main\'s record by the run that uploaded it, not by its own event', () => {
  const art = (over: Record<string, unknown>, run: Record<string, unknown> = {}) => ({
    name: ARTIFACT,
    expired: false,
    created_at: '2026-10-18T10:00:00Z',
    ...over,
    workflow_run: { id: 1, head_branch: 'main', head_sha: 'a', repository_id: 7, head_repository_id: 7, ...run },
  })

  it('takes the newest from main, whatever order the list came in', () => {
    const older = art({ created_at: '2026-10-17T10:00:00Z' }, { id: 1 })
    const newer = art({ created_at: '2026-10-18T10:00:00Z' }, { id: 2 })
    expect(pickMainArtifact([older, newer]).workflow_run.id).toBe(2)
  })

  it.each([
    ['a merge-queue batch', art({ created_at: '2026-10-19T00:00:00Z' }, { id: 9, head_branch: 'queue/batch-41' })],
    ['a fork\'s branch named main', art({ created_at: '2026-10-19T00:00:00Z' }, { id: 9, head_repository_id: 8 })],
    ['an expired one', art({ created_at: '2026-10-19T00:00:00Z', expired: true }, { id: 9 })],
    ['another artifact', art({ created_at: '2026-10-19T00:00:00Z', name: 'centralu-linux-x64' }, { id: 9 })],
  ])('skips %s', (_, skipped) => {
    expect(pickMainArtifact([skipped, art({}, { id: 1 })]).workflow_run.id).toBe(1)
  })

  it('answers nothing when main has no record', () => {
    expect(pickMainArtifact([])).toBeNull()
    expect(pickMainArtifact(undefined)).toBeNull()
  })

  it('wires verify: fetch main\'s record, compare in pnpm verify, upload this run\'s', () => {
    const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
    const verify = workflow.split(/^ {2}verify:\n/m)[1]!.split(/^ {2}\S/m)[0]!
    const fetch = verify.indexOf('run: node .github/scripts/bundle-base.mjs "$RUNNER_TEMP/bundle-base"')
    const run = verify.indexOf('- run: pnpm verify')
    const upload = verify.indexOf(`name: ${ARTIFACT}\n`)
    expect(fetch).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(fetch)
    expect(upload).toBeGreaterThan(run)
    expect(verify).toContain('CC_BUNDLE_BASE: ${{ runner.temp }}/bundle-base/bundle-size.json')
    expect(verify).toContain('CC_BUNDLE_RECORD: ${{ runner.temp }}/bundle-size/bundle-size.json')
    expect(verify).toContain('path: ${{ runner.temp }}/bundle-size/bundle-size.json')
  })
})
