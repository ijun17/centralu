/**
 * Paths are not taken apart on `/` by hand (issue #47).
 *
 * `'C:\Users\me\a.ts'.split('/')` is one segment: the whole string. Twenty-one places did that,
 * and the three that mattered were the ones deciding things — the filename extraction inside the
 * host's "nothing outside the project root" check (#18/#19), the `..` rejection for clickable
 * paths (#39), and five sites in the mock, which is the worst of the three: the contract test
 * exists to catch the mock and the host disagreeing, and on this axis they agreed on the same
 * wrong thing, so e2e would have stayed green while the app misbehaved.
 *
 * Sweeping them once is not enough, for the reason the `⌘` sweep in styles.test.ts gives: a
 * half-swept repository is worse than either extreme. `split('/')` is not obviously wrong to
 * look at — it is what everyone writes — so the next one goes in beside the last one and nobody
 * notices. It gets caught here instead.
 *
 * **What this cannot do.** It reads text, so it only recognises the spelling the survey counted:
 * a literal `/` handed to `split` or `join`. `lastIndexOf('/')`, a regex, or a separator behind
 * a constant all walk past it. That is the same deal the `⌘` check makes — a speed bump with a
 * name on it, not a proof — and it is worth stating rather than implying, because the failure
 * mode of believing otherwise is thinking this axis is closed when it is not.
 *
 * A `no-restricted-syntax` ESLint rule would read the AST instead of the text and would be the
 * stronger form of this. It was not taken here because it belongs in the root `eslint.config.js`,
 * which is outside what this change was scoped to touch.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** `.split('/')` and `.join('/')`, in any quoting */
const HAND_SPLIT = /\.(split|join)\(\s*(['"`])\/\2\s*\)/

/**
 * The one file allowed to write the separator down, because writing it down is its subject.
 * Everything else asks it — which is what makes "the wire is POSIX" a decision rather than a
 * habit that twenty-one files happen to share.
 */
const DEFINES_THE_ENCODING = 'protocol/src/paths.ts'

/**
 * Tests are out, as they are for `⌘`. A test that spells a POSIX path out is *pinning* one, not
 * assuming one, and the fixtures would have to be written in some separator or other regardless.
 * Nothing here ships.
 */
function shippedSources(): { id: string; text: string }[] {
  const packages = join(ROOT, 'packages')
  const out: { id: string; text: string }[] = []
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src')
    let files: string[]
    try {
      files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const f of files) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
      out.push({ id: `${pkg}/src/${f}`, text: readFileSync(join(src, f), 'utf8') })
    }
  }
  return out
}

/** Comments are not code. This file's own prose is full of the thing it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('paths are not split on a hardcoded separator', () => {
  const sources = shippedSources()

  it('the sweep actually reached some files', () => {
    // A walk that quietly matches nothing passes every check below for the wrong reason
    expect(sources.length).toBeGreaterThan(20)
    // …and an exemption that names a file which is not there is an exemption for nobody
    expect(sources.map((f) => f.id)).toContain(DEFINES_THE_ENCODING)
  })

  it('nothing outside the protocol writes the separator itself', () => {
    const offenders = sources
      .filter((f) => !f.id.endsWith(DEFINES_THE_ENCODING))
      .filter((f) => HAND_SPLIT.test(code(f.text)))
      .map((f) => f.id)
    expect(offenders, 'use wireSegments · wireBaseName · wireJoin from @cc/protocol').toEqual([])
  })

  it('the check would notice if one came back', () => {
    // Otherwise a typo in the pattern reads as "the repository is clean"
    expect(HAND_SPLIT.test(`const name = p.split('/').pop()`)).toBe(true)
    expect(HAND_SPLIT.test(`const path = parts.join("/")`)).toBe(true)
    // …and does not fire on the things that merely look like it
    expect(HAND_SPLIT.test(`const lines = text.split('\\n')`)).toBe(false)
    expect(HAND_SPLIT.test(`const parts = name.split(/[-:_/]/)`)).toBe(false)
  })
})
