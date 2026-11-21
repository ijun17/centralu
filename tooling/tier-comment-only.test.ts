import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so pre-pr and the board can run it with Node alone
import { COMMENT_ONLY_TIER, commentsOnly, RULES_FILE, tierOfChange } from '../scripts/tier.mjs'

/**
 * A TypeScript or JavaScript file whose change is only in comments, spaces and blank lines takes at most light (#2352),
 * so a comment fix in a deep file (packages/protocol) is not reviewed as deep. Whatever cannot be judged keeps its tier.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVENTS = 'packages/protocol/src/events.ts'
const judge = (path: string, before: string, after: string): boolean => commentsOnly(path, before, after, ts)

/** [file, before, after]: each pair differs */
const COMMENT_ONLY: [string, string, string][] = [
  ['a.ts', 'const a = 1 // x\n', 'const a = 1 // y\n\n'],
  ['a.ts', '/** doc */\nexport const a = 1\n', '/** other doc\n * more */\n  export const a = 1\n'],
  ['a.ts', 'f() /* a */\n', 'f() /* b */\n'],
  ['a.ts', '// a\n// eslint-disable-next-line x\nf()\n', '// b\n// eslint-disable-next-line x\nf()\n'],
  ['a.ts', '// header\n\nexport const a = 1\n', 'export const a = 1\n'],
  ['a.mjs', '// hi\nexport const a = 1\n', '// there\nexport const a = 1\n'],
  ['a.tsx', 'const x = <div>{/* a */}</div>\n', 'const x = <div>{/* b */}</div>\n'],
]

/** [file, before, after, why]: each changes what runs or what is checked, or cannot be judged */
const NOT_COMMENT_ONLY: [string, string, string, string][] = [
  ['a.ts', 'const a = 1\n', 'const a = 2\n', 'a token'],
  ['a.ts', 'f()\ng()\n', 'f(); g()\n', 'a line break taken from between two tokens'],
  ['a.ts', 'const a: number = 1\n', '// @ts-expect-error\nconst a: number = 1\n', 'a TypeScript directive'],
  ['a.ts', 'f()\n', '// eslint-disable-next-line no-x\nf()\n', 'an ESLint directive'],
  ['a.ts', 'f(); // eslint-disable-line x\n', 'f(); // eslint-disable-line y\n', 'an ESLint directive on the line'],
  ['a.ts', '// eslint-disable-next-line x\nf()\ng()\n', 'f()\n// eslint-disable-next-line x\ng()\n', 'a directive moved to another line'],
  ['a.ts', '// eslint-disable-next-line no-x\nbad()\n', '// eslint-disable-next-line no-x\n\nbad()\n', 'a blank line between a directive and its line'],
  ['a.ts', '// eslint-disable-next-line no-x\n// why\nbad()\n', '// eslint-disable-next-line no-x\nbad()\n', 'a comment taken from between a directive and its line'],
  ['a.ts', 'const a = [1,  2]\n', '// prettier-ignore\nconst a = [1,  2]\n', 'Prettier\'s ignore'],
  ['a.ts', 'import(/* x */ m)\n', 'import(/* @vite-ignore */ m)\n', 'a bundler hint'],
  ['a.ts', '/* @ts-nocheck */\nf()\n', 'f()\n', 'a pragma'],
  ['a.ts', 'f()\n/** doc */\n', 'f() // eslint-disable-line no-x\n/** doc */\n', 'a directive before a JSDoc that ends the file'],
  ['a.ts', '#!/usr/bin/env node\nx()\n', '#!/usr/bin/env bun\nx()\n', 'the #! line'],
  ['a.ts', '#!/usr/bin/env node\nf()\n', '#!/usr/bin/env node\r\nf()\n', 'the #! line\'s ending'],
  ['a.ts', "const s = 'a // b'\n", "const s = 'a // c'\n", 'a string that looks like a comment'],
  ['a.ts', 'const s = `a /* b */`\n', 'const s = `a /* c */`\n', 'a template that looks like a comment'],
  ['a.ts', 'const r = /\\/\\/ x/\n', 'const r = /\\/\\/ y/\n', 'a regular expression that looks like a comment'],
  ['a.ts', 'function f() { return /*\n*/ 1 }\n', 'function f() { return /* */ 1 }\n', 'a line break inside a comment, which ends a return'],
  ['a.ts', 'const = \n', 'const = // x\n', 'a file that does not parse'],
  ['a.mjs', '/** @type {number} */\nexport const a = 1\n', '/** @type {string} */\nexport const a = 1\n', 'a JSDoc type in JavaScript'],
  ['a.js', 'f()\n/** @typedef {number} N */\n', 'f()\n/** @typedef {string} N */\n', 'a JSDoc type that ends a JavaScript file'],
  ['a.js', 'x = a < !--y\n', 'x = a <!--y\n', 'an HTML-like comment in a classic script'],
  ['a.tsx', 'const x = <div>// a</div>\n', 'const x = <div>// b</div>\n', 'JSX text that looks like a comment'],
  ['a.rs', 'fn a() {} // c\n', 'fn a() {} // d\n', 'Rust, which keeps its name\'s tier'],
  ['a.json', '{}', '{ }', 'a kind it does not read'],
  ['a.md', '<!-- a -->', '<!-- b -->', 'a kind it does not read'],
]

describe('a change of comments only (#2352)', () => {
  it.each(COMMENT_ONLY)('counts %s %j → %j as comments only', (path, before, after) => {
    expect(judge(path, before, after)).toBe(true)
  })

  it.each(NOT_COMMENT_ONLY)('does not count %s %j → %j: %s', (path, before, after) => {
    expect(judge(path, before, after)).toBe(false)
  })

  it('judges nothing without the typescript package, or when it cannot tell that the file parsed cleanly', () => {
    expect(commentsOnly('a.ts', '// a\nf()\n', '// b\nf()\n', null)).toBe(false)
    // a typescript whose source files carry no parse diagnostics: `type T = : # /[//]/ evil()` would read as `good()`
    const noDiagnostics = Object.create(ts, {
      createSourceFile: {
        value: (...args: Parameters<typeof ts.createSourceFile>) => {
          const sf = ts.createSourceFile(...args)
          Reflect.deleteProperty(sf, 'parseDiagnostics')
          return sf
        },
      },
    })
    expect(commentsOnly('a.ts', '// a\nf()\n', '// b\nf()\n', noDiagnostics)).toBe(false)
    expect(commentsOnly('a.ts', 'type T =  : # /[//]/ evil()\n', 'type T =  : # /[//]/ good()\n', noDiagnostics)).toBe(false)
  })

  it('reads the protocol\'s events.ts: a comment edited is comments only, one token changed is not', () => {
    const text = readFileSync(join(ROOT, EVENTS), 'utf8')
    const firstCode = text.search(/^export /m)
    const commented = `${text.slice(0, firstCode)}// A comment the fix adds.\n${text.slice(firstCode)}`
    expect(judge(EVENTS, text, commented)).toBe(true)
    expect(judge(EVENTS, text, text.replace(/^export /m, 'export  '))).toBe(true)
    expect(judge(EVENTS, text, text.replace(/^export (type|const|interface) (\w)/m, 'export $1 X$2'))).toBe(false)
  })
})

describe('pnpm tier with a comment-only change in a deep file (#2352)', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' }
  const REAL_TYPESCRIPT = createRequire(import.meta.url).resolve('typescript')
  let repo = ''
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const read = (path: string) => readFileSync(join(repo, path), 'utf8')
  /** The typescript the checkout installs: `module` is its index.js */
  const installTypescript = (module: string) => {
    write('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', main: 'index.js' }))
    write('node_modules/typescript/index.js', module)
  }
  const change = (edits: Record<string, string>) => {
    for (const [path, text] of Object.entries(edits)) write(path, text)
    git('add', '-A')
    git('commit', '-q', '-m', 'change')
    return tierOfChange({ root: repo, base: 'main', head: 'top' })
  }
  const withComment = () => ({ [EVENTS]: read(EVENTS).replace(/^export /m, '// A comment the fix adds.\nexport ') })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-tier-comments-'))
    git('init', '-q', '-b', 'main')
    for (const path of [RULES_FILE, EVENTS]) write(path, readFileSync(join(ROOT, path), 'utf8'))
    write('.gitignore', 'node_modules/\n')
    write('packages/ui/src/features/x.tsx', 'export const x = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main')
    git('checkout', '-q', '-b', 'top')
    installTypescript(`module.exports = require(${JSON.stringify(REAL_TYPESCRIPT)})\n`)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps the tier of the rest of the change when events.ts only gains a comment', () => {
    const r = change({ ...withComment(), 'packages/ui/src/features/x.tsx': 'export const x = 2\n' })
    expect(r.tier).toBe('light')
    expect(r.files.find((f: { path: string }) => f.path === EVENTS)).toMatchObject({ tier: COMMENT_ONLY_TIER, commentsOnly: 'deep' })
    expect(r.line).toContain(`\`${EVENTS}\` (only comments changed, else deep)`)
    expect(r.text).toContain('only its comments, spaces and blank lines changed, so at most light (by its name: deep)')
  })

  it('takes events.ts with an edited comment as light, but one token changed, a directive comment added or a new file as deep', () => {
    const text = read(EVENTS)
    const onMain = (edits: Record<string, string>) => {
      git('reset', '-q', '--hard', 'main')
      return change(edits).tier
    }
    expect(onMain(withComment())).toBe('light')
    expect(onMain({ [EVENTS]: text.replace(/^export (type|const|interface) (\w)/m, 'export $1 X$2') })).toBe('deep')
    expect(onMain({ [EVENTS]: text.replace(/^export /m, '// eslint-disable-next-line no-x\nexport ') })).toBe('deep')
    expect(onMain({ 'packages/protocol/src/new.ts': '// only a comment\n' })).toBe('deep')
  })

  it('reads typescript from the checkout, and judges nothing when it is missing there or has no JavaScript API (typescript 7)', () => {
    // Node keeps a module loaded from a path for the whole process; a run of pnpm tier loads it once
    const forgetCheckoutModules = () => {
      const cache = createRequire(import.meta.url).cache
      const prefixes = [repo, realpathSync(repo)].map((p) => p.toLowerCase())
      for (const key of Object.keys(cache)) if (prefixes.some((p) => key.toLowerCase().startsWith(p))) Reflect.deleteProperty(cache, key)
    }
    const onMain = (prepare: () => void) => {
      git('reset', '-q', '--hard', 'main')
      forgetCheckoutModules()
      prepare()
      return change(withComment()).tier
    }
    expect(onMain(() => {})).toBe('light')
    expect(onMain(() => rmSync(join(repo, 'node_modules'), { recursive: true, force: true }))).toBe('deep')
    expect(onMain(() => installTypescript('module.exports = { version: "7.0.2" }\n'))).toBe('deep')
  })

  it('does not take two bytes that are not UTF-8 for one text', () => {
    writeFileSync(join(repo, EVENTS), Buffer.concat([Buffer.from('export const x = "'), Buffer.from([0xe9]), Buffer.from('" // a\n')]))
    git('commit', '-q', '-am', 'latin-1')
    git('branch', '-f', 'main', 'HEAD')
    writeFileSync(join(repo, EVENTS), Buffer.concat([Buffer.from('export const x = "'), Buffer.from([0xe8]), Buffer.from('" // b\n')]))
    git('commit', '-q', '-am', 'another byte')
    expect(tierOfChange({ root: repo, base: 'main', head: 'top' }).tier).toBe('deep')
    writeFileSync(join(repo, EVENTS), 'export const x = 1 // a\n')
    git('commit', '-q', '-am', 'utf-8')
    git('branch', '-f', 'main', 'HEAD')
    expect(change({ [EVENTS]: 'export const x = 1 // b\n' }).tier).toBe('light')
  })

  it('throws when git cannot read a file, as when it is interrupted, rather than judge the file by its name', () => {
    write(EVENTS, withComment()[EVENTS])
    git('commit', '-q', '-am', 'a comment')
    const blob = git('rev-parse', `top:${EVENTS}`)
    const object = join(repo, '.git/objects', blob.slice(0, 2), blob.slice(2))
    chmodSync(object, 0o644)
    rmSync(object)
    expect(() => tierOfChange({ root: repo, base: 'main', head: 'top' })).toThrow(`git cat-file blob ${blob}`)
  })
})
