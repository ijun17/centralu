/** The repository-wide guards `pnpm pre-pr` runs (tooling/guards.ts, #2373): what each declares, and which guards a change touches */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changedGuards, GUARDS, NOT_GUARDS, type Change } from './guards.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOC_REFS = ['tooling/doc-refs.test.ts']

/** A change of `path` from `before` to `after` (null: no file) */
const change = (path: string, before: string | null, after: string | null): Change => ({ path, before: () => before, after: () => after })

describe('the repository-wide guards', () => {
  it('declares only tests and files that are in this repository', () => {
    const missing = GUARDS.flatMap((g) => [g.test, ...g.reads]).filter((f) => !existsSync(join(ROOT, f)))
    expect(missing, `tooling/guards.ts declares what the repository does not have: ${missing.join(', ')}`).toEqual([])
  })

  it('names the tests of each guard, so one run against a pull request runs those only', () => {
    const unnamed = GUARDS.filter((g) => !g.tests?.trim()).map((g) => g.test)
    expect(unnamed, `tooling/guards.ts: give each guard the names of its tests (its describes', when all of them are): ${unnamed.join(', ')}`).toEqual([])
  })

  it('names every tooling test once, as a guard or under why it is not one', () => {
    const tests = execFileSync('git', ['ls-files', '-z', '--', 'tooling'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => /\.test\.[cm]?tsx?$/.test(f))
    const named = [...GUARDS.map((g) => g.test), ...Object.values(NOT_GUARDS).flat()]
    const unnamed = tests.filter((t) => !named.includes(t))
    const wrong = named.filter((t, i) => !tests.includes(t) || named.indexOf(t) !== i)
    expect(
      { unnamed, wrong },
      `tooling/guards.ts: add each test to GUARDS, or to NOT_GUARDS under why it is not a guard (not named: ${unnamed.join(', ') || 'none'}); name each once, and only tests that are there (${wrong.join(', ') || 'none'})`,
    ).toEqual({ unnamed: [], wrong: [] })
  })

  it('counts a change to a guard test or to a file it reads, and to nothing else', () => {
    expect(changedGuards([change('tooling/os-allowlist.txt', 'a\n', 'a\nb\n')])).toEqual(['tooling/os-layer.test.ts'])
    expect(changedGuards([change('tooling/os-tests.ts', 'a', 'b')])).toEqual(['tooling/os-layer.test.ts'])
    expect(changedGuards([change('tooling/doc-refs.ts', 'a', 'b')])).toEqual(DOC_REFS)
    // An exception added for a file another pull request deletes or renames fails there
    expect(changedGuards([change('tooling/guard-exceptions.js', 'a', 'b')])).toEqual(['tooling/guards-checks.test.ts'])
    // Every registered adapter is held to what these say: another pull request that adds an adapter fails a tighter one
    expect(changedGuards([change('packages/platform/src/mock/tools.ts', 'a', 'b')])).toEqual(['tooling/mock-capability-parity.test.ts'])
    expect(changedGuards([change('.github/workflows/drift.yml', 'a', 'b')])).toEqual(['tooling/drift-workflow.test.ts'])
    expect(changedGuards([change('tooling/os-layer.test.ts', 'a', 'b'), change('tooling/doc-refs.test.ts', 'a', null)])).toEqual([...DOC_REFS, 'tooling/os-layer.test.ts'])
    expect(changedGuards([change('tooling/heavy-store.test.ts', 'a', 'b'), change('packages/ui/src/a.ts', null, 'b'), change('docs/notes.txt', '## 1. One\n', null)])).toEqual([])
  })

  it('counts a document only when it loses something a reference may cite', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8').replace(/\r\n/g, '\n')
    const docs = (before: string | null, after: string | null, path = 'docs/architecture.md') => changedGuards([change(path, before, after)])
    const heading = '## 2. Layers and dependency rules'
    const lead = '**Dependency rules (a violation is a lint error, not a review comment):**'
    expect(doc).toContain(heading)
    expect(doc).toContain(lead)
    // More words and a new section take nothing away, nor does a new document
    expect(docs(doc, `${doc}\n## 99. A new section\n\nMore words.\n`)).toEqual([])
    expect(docs(doc, doc.replace(lead, `${lead} More words.`))).toEqual([])
    expect(docs(null, '# A new document\n', 'docs/new.md')).toEqual([])
    // A section number, a heading's text (and its anchor), a bold lead-in, the document: gone
    expect(docs(doc, doc.replace(heading, '## Layers and dependency rules'))).toEqual(DOC_REFS)
    expect(docs(doc, doc.replace(heading, '## 2. Layers'))).toEqual(DOC_REFS)
    expect(docs(doc, doc.replace(lead, 'Dependency rules:'))).toEqual(DOC_REFS)
    expect(docs(doc, null)).toEqual(DOC_REFS)
    // An item of a numbered list under a numbered heading is a section too (§1.2.3): one that is no longer numbered is gone
    const spec = readFileSync(join(ROOT, 'docs', 'product-spec.md'), 'utf8').replace(/\r\n/g, '\n')
    const item = '\n3. **Stay light**'
    expect(spec).toContain(item)
    expect(docs(spec, spec.replace(item, '\n**Stay light**'), 'docs/product-spec.md')).toEqual(DOC_REFS)
    // A new folder index turns a document's name into the folder's: what cites the old file is a finding then
    expect(docs(null, '# Architecture\n', 'docs/architecture/README.md')).toEqual(DOC_REFS)
  })
})
