/** `guard/doc-refs`: a `<doc> §n`, `<doc>.md "Heading"`, `<doc>.md HO1` or Markdown link reference points at a section that exists (tooling/doc-refs.ts; #2179) */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anchorOf, danglingRefs, indexDocs, indexTexts, scanRepository } from './doc-refs.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('guard/doc-refs', () => {
  it('finds no reference to a section that is not there', () => {
    expect(scanRepository(ROOT)).toEqual([])
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

  it('reads no reference in code: a fenced block or a code span of a Markdown file, for every form', () => {
    const index = indexTexts(new Map([['docs/a.md', '# A\n\n## 1. One `code`\n\n```\n## 2. In a fence\n```\n']]))
    const text = [
      '```sh',
      'a §2 and [x](a.md#gone) and docs/a.md "Nothing" and docs/a.md §2',
      '```',
      '`a §2` and `[x](a.md#gone)` and `docs/a.md "Nothing"` are code',
      '`a.md` §2 and [x](a.md#gone) and docs/a.md "One `code`" and docs/a.md "Nothing" are not',
    ].join('\n')
    expect(danglingRefs(text, index, 'docs/b.md')).toEqual([
      '5: a.md has no section 2',
      '5: docs/a.md has no heading "Nothing"',
      '5: docs/a.md has no heading #gone',
    ])
  })

  it('reads a name starting ./ or ../ from the citing file, as a link is', () => {
    const index = indexTexts(
      new Map([
        ['docs/a/README.md', '# A\n'],
        ['docs/a/keeper.md', '# Keeper of a\n\n## 1. One\n'],
        ['docs/b/keeper.md', '# Keeper of b\n\n## 2. Two\n'],
      ]),
    )
    const text = [
      './keeper.md §1 and ../b/keeper.md §2 are there',
      './keeper.md §2',
      '../b/keeper.md §1 and ../b/keeper.md "One"',
      '../c/keeper.md §1',
      '../a.md §1 and ../a/gone.md §1',
    ].join('\n')
    expect(danglingRefs(text, index, 'docs/a/x.md')).toEqual([
      '2: ./keeper.md has no section 2',
      '3: ../b/keeper.md has no section 1',
      '3: ../b/keeper.md has no heading "One"',
      '4: ../c/keeper.md does not exist',
      '5: ../a.md is a folder now: cite the file under it',
      '5: ../a/gone.md is no file of the a/ folder',
    ])
  })

  it('gives a heading the anchor GitHub gives it', () => {
    const headings = ['_Emphasis_ and snake_case', '`_private` field', '__Bold__ *star* (#12): [a link](x.md)', 'Größe – „quoted“ v1.2']
    expect(headings.map(anchorOf)).toEqual(['emphasis-and-snake_case', '_private-field', 'bold-star-12-a-link', 'größe--quoted-v12'])
  })

  it("reads a section on a comment's next line, past its comment mark", () => {
    const index = indexDocs(ROOT, ['docs/architecture.md', 'docs/releasing.md', 'AGENTS.md', '.centralu/apps/project-board/AGENTS.md'])
    const text = [
      '//! started as the shell does (docs/architecture.md',
      '//! §6.2). Debug builds start the keeper.',
      '   * the release (docs/releasing.md',
      '   * "No such heading here").',
      '# docs/architecture.md',
      '# §2 is there',
      '// each family lives in its own file (AGENTS.md,',
      '// "Files"): the AGENTS.md beside this file, not the root one',
    ].join('\n')
    expect(danglingRefs(text, index, '.centralu/apps/project-board/server.mjs')).toEqual([
      '1: docs/architecture.md has no section 6.2',
      '3: docs/releasing.md has no heading "No such heading here"',
    ])
  })

  it('reads a rule id cited after the document that holds it', () => {
    const index = indexTexts(
      new Map([
        ['docs/runtime-lessons/README.md', '# Lessons\n'],
        ['docs/runtime-lessons/host-contract.md', '# Host\n\n**HO1. Stdout carries the handshake only.**\nRule: text.\n'],
        ['docs/runtime-lessons/remotes.md', '# Remotes\n\n**RE18. A first line can be late.**\n'],
      ]),
    )
    const text = [
      'docs/runtime-lessons/host-contract.md HO1, HO2',
      '`docs/runtime-lessons/host-contract.md` RE18',
      'docs/runtime-lessons.md HO1',
      'runtime-lessons/remotes.md RE18; HO9 on its own is not read',
      'runtime-lessons/remotes.md RE18a',
    ].join('\n')
    expect(danglingRefs(text, index)).toEqual([
      '1: docs/runtime-lessons/host-contract.md has no rule HO2',
      '2: docs/runtime-lessons/host-contract.md has no rule RE18',
      '3: docs/runtime-lessons.md is a folder now: cite the file under it',
      '5: runtime-lessons/remotes.md has no rule RE18a',
    ])
  })
})
