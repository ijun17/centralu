/** `guard/doc-refs`: a `<doc> §n`, `<doc>.md "Heading"` or Markdown link reference points at a section that exists (tooling/doc-refs.ts; #2179) */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { danglingRefs, indexDocs, indexTexts, scanRepository } from './doc-refs.js'

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

  it('reads a document split into a folder: its old name, a path into the folder, and a link and its anchor', () => {
    const index = indexTexts(
      new Map([
        ['docs/agent-host/README.md', '# Agent host\n'],
        ['docs/agent-host/usage.md', '# Usage and limits (FR-9)\n\n## Usage over time (#1452)\n\n**Asking.** How.\n'],
        ['docs/agent-host/keeper.md', '# The keeper\n'],
        ['docs/usage.md','# Usage elsewhere\n\n## Something else\n'],
      ]),
    )
    const text = [
      'docs/agent-host.md §6.2 and agent-host §6',
      'see docs/agent-host.md for it',
      'docs/agent-host/usage.md "Usage over time" and agent-host/usage.md "Something else" and agent-host/usage.md "Asking"',
      'docs/agent-host/limits.md is not there',
      '[a](usage.md#usage-over-time-1452) [b](usage.md#nothing) [c](README.md) [d](limits.md) [e](#usage-and-limits-fr-9) [f](#gone)',
      'the keeper §6 of a plan, a sub-document named by its bare name, is not read',
    ].join('\n')
    expect(danglingRefs(text, index, 'docs/agent-host/usage.md')).toEqual([
      '1: docs/agent-host.md is a folder now: cite the file under it',
      '1: agent-host.md is a folder now: cite the file under it',
      '2: docs/agent-host.md is a folder now: cite the file under it',
      '3: agent-host/usage.md has no heading "Something else"',
      '4: docs/agent-host/limits.md is no file of the agent-host/ folder',
      '5: docs/agent-host/usage.md has no heading #nothing',
      '5: limits.md is no document',
      '5: docs/agent-host/usage.md has no heading #gone',
    ])
  })
})
