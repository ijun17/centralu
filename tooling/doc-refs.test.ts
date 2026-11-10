/** `guard/doc-refs`: a `<doc> §n` or `<doc>.md "Heading"` reference points at a section that exists (tooling/doc-refs.ts; #2179) */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { danglingRefs, indexDocs, scanRepository } from './doc-refs.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('guard/doc-refs', () => {
  it('finds no reference to a section that is not there', () => {
    expect(scanRepository(ROOT).findings).toEqual([])
  })

  it('tells a section that exists from one that does not, in the forms the repository writes', () => {
    const index = indexDocs(ROOT, ['docs/architecture.md', 'docs/plans/mailbox.md', 'docs/releasing.md'])
    const text = [
      'architecture §2 and docs/plans/mailbox.md §10.1 and mailbox §7.7',
      'architecture §6.2',
      'docs/architecture.md §9, §2',
      'docs/plans/mailbox.md §99.1',
      'docs/releasing.md "Host-only packages" and docs/releasing.md, "No such heading here"',
      'docs/nothing.md §1',
      'plan §4 means the plan the comment sits in',
      '[architecture.md](architecture.md) §7.7 and `architecture.md` §8.8 and architecture §2 or §9.9',
      '[releasing.md](releasing.md) "Nothing like it"',
    ].join('\n')
    expect(danglingRefs(text, index)).toEqual([
      '2: architecture has no section 6.2',
      '3: docs/architecture.md has no section 9',
      '4: docs/plans/mailbox.md has no section 99.1',
      '5: docs/releasing.md has no heading "No such heading here"',
      '6: docs/nothing.md does not exist',
      '8: architecture.md has no section 7.7',
      '8: architecture.md has no section 8.8',
      '8: architecture has no section 9.9',
      '9: releasing.md has no heading "Nothing like it"',
    ])
  })
})
