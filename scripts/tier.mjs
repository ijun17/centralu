// A change's risk tier, by the paths it touches (#1259 step 2): `pnpm tier`.
//
// The rules are .centralu/tiers.json. Each file takes the highest tier of the rules that match it
// (light when none does), a test also its subject's (x.test.ts: x.ts), and the change takes the
// highest tier of its files. No rules, rules that cannot be read, or any failure: deep.
//
//   auto    lands after the fast gate with no review (docs, fixture data, UI assets).
//   light   one review by another model inside the author's session before it says done.
//   deep    a separate review session that runs real-environment cases.
//   person  the owner decides; never given by path, only by the label tier:person set by hand.
//
// What says why: the files at the change's tier, each with the rules that put it there.
//
//   node scripts/tier.mjs [--base <ref>] [--head <ref>] [--json]      the commits from base to head
//   node scripts/tier.mjs [--json] -- <path>...                        the paths given
//
// A file's mode counts too (git diff --raw): a symbolic link or a submodule is deep, and a file executable in the
// new commit at least light, whatever its name says. A TypeScript or JavaScript file whose change is only in comments,
// spaces and blank lines is at most light (#2352, `commentsOnly`): a comment fix in a deep file does not make the change deep.
//
// --base defaults to origin/main, --head to HEAD; the change is what head adds over where it left
// base. The rules are read from base, so a change cannot loosen the rules that judge it; a base
// without them (before they existed) leaves the head's. pre-pr.mjs puts the tier in its answer, and the
// board's open_pr writes it into Verified and labels the pull request tier:<name>.
//
// The merge queue's hook: the tier of what it lands is the higher of `tierOfChange` at that head
// and `tierOfLabels(labels)` (the highest tier:<name> label: open_pr's, from when it opened, or a
// person's, raised by hand; none is deep). The label alone goes stale when commits are pushed after it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULES_FILE = '.centralu/tiers.json'
export const TIERS = ['auto', 'light', 'deep', 'person']
export const LABEL_PREFIX = 'tier:'

// --- Rules --------------------------------------------------------------------------------------

/** A glob as a regular expression over a whole path: `**` any number of folders, `*` and `?` within one name, `{a,b}` either. */
export function globToRegExp(glob, flags = '') {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/'
      if (atStart && glob[i + 2] === '/') {
        re += '(?:[^/]+/)*'
        i += 2
      } else if (atStart && i + 2 === glob.length) {
        re += '.*'
        i += 1
      } else throw new Error(`${glob}: ** stands only for whole folders (a/**/b, a/**, **/b).`)
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) throw new Error(`${glob}: a { has no }.`)
      const parts = glob.slice(i + 1, end).split(',')
      if (parts.some((p) => /[*?{/]/.test(p))) throw new Error(`${glob}: {a,b} takes plain names only.`)
      re += `(?:${parts.map(escape).join('|')})`
      i = end
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`, flags)
}

/**
 * A glob with each `{a,b}` list of names spelled out, one glob per name, so a test can find a name that no longer matches a
 * file. A list in a name with a wildcard (`*.{md,txt}`) is a set of kinds, not of files, and stays.
 */
export function globNames(glob) {
  for (const m of glob.matchAll(/\{([^}]*)\}/g)) {
    const end = glob.indexOf('/', m.index)
    if (/[*?]/.test(glob.slice(glob.lastIndexOf('/', m.index) + 1, end < 0 ? undefined : end))) continue
    return m[1].split(',').flatMap((name) => globNames(glob.slice(0, m.index) + name + glob.slice(m.index + m[0].length)))
  }
  return [glob]
}

const escape = (s) => s.replace(/[.+^$()|[\]\\}]/g, '\\$&')

/** The rules file's contents, checked; throws with what is wrong. */
export function parseRules(text, source = RULES_FILE) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${source} is not JSON: ${e.message}`)
  }
  const fail = (why) => {
    throw new Error(`${source}: ${why}`)
  }
  if (JSON.stringify(raw?.tiers) !== JSON.stringify(TIERS)) fail(`tiers must be ${JSON.stringify(TIERS)}, lowest first.`)
  if (!TIERS.includes(raw.fallback) || raw.fallback === 'person') fail('fallback must be auto, light or deep.')
  if (!Array.isArray(raw.rules)) fail('rules must be a list.')
  const ids = new Set()
  const rules = raw.rules.map((r, n) => {
    const at = `rule ${r?.id ?? n + 1}`
    if (typeof r?.id !== 'string' || !r.id) fail(`rule ${n + 1} has no id.`)
    if (ids.has(r.id)) fail(`two rules are called ${r.id}.`)
    ids.add(r.id)
    if (!TIERS.includes(r.tier)) fail(`${at}: no tier is called ${r.tier}.`)
    if (r.tier === 'person') fail(`${at}: person is set by hand, never by path.`)
    if (typeof r.why !== 'string' || !r.why.trim()) fail(`${at} needs its why.`)
    if (r.ignoreCase !== undefined && typeof r.ignoreCase !== 'boolean') fail(`${at}: ignoreCase is true or false.`)
    // ignoreCase: the globs match whatever the case (a script named x.BAT runs on Windows and macOS as x.bat does)
    const flags = r.ignoreCase ? 'i' : ''
    const globs = (list, key) => {
      if (list === undefined && key === 'except') return []
      if (!Array.isArray(list) || (key === 'paths' && !list.length) || list.some((g) => typeof g !== 'string' || !g)) fail(`${at}: ${key} must be a list of globs.`)
      return list.map((g) => {
        try {
          return globToRegExp(g, flags)
        } catch (e) {
          return fail(`${at}: ${e.message}`)
        }
      })
    }
    return { id: r.id, tier: r.tier, why: r.why.trim(), paths: globs(r.paths, 'paths'), except: globs(r.except, 'except') }
  })
  return { fallback: raw.fallback, rules }
}

const rank = (tier) => TIERS.indexOf(tier)
const higher = (a, b) => (rank(b) > rank(a) ? b : a)

/** A path's own tier by the rules: { tier, rules } with the ids of the rules that gave it (none: the fallback). */
function ownTier(p, rules) {
  const hits = rules.rules.filter((r) => r.paths.some((re) => re.test(p)) && !r.except.some((re) => re.test(p)))
  if (!hits.length) return { tier: rules.fallback, rules: [] }
  const tier = hits.map((r) => r.tier).reduce(higher)
  return { tier, rules: hits.filter((r) => r.tier === tier).map((r) => r.id) }
}

const CODE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']

/**
 * The files a test file tests, by name: x.test.ts and x.test-helpers.ts test x.<any code extension>
 * (their own first); a folder's tests.rs tests its mod.rs and the folder's <name>.rs. Whether those
 * exist does not matter: the rules are paths. A Playwright x.spec.ts tests the UI, not a file beside it.
 */
export function subjectsOf(path) {
  const m = /^(.+?)\.(?:test|test-helpers)\.([cm]?[jt]sx?)$/.exec(path)
  if (m) return [m[2], ...CODE_EXTENSIONS.filter((e) => e !== m[2])].map((e) => `${m[1]}.${e}`)
  const rs = /^(.+)\/tests\.rs$/.exec(path)
  return rs ? [`${rs[1]}/mod.rs`, `${rs[1]}.rs`] : []
}

/** git's file modes that say what a path is, beside a plain file (100644) */
export const MODES = { link: '120000', submodule: '160000', executable: '100755' }

/**
 * What a change to a path's mode makes it, whatever its name: { tier, mode } or null. A symbolic link or a
 * submodule (either side of the change) is deep: the name says nothing of what it points at, and a build reads
 * the target (an asset that links outside the repository is bundled from there). A file executable in the new
 * commit (new, the bit added, or edited while it has it) is at least light: something will run it.
 */
export function modeTier(entry) {
  if (!entry) return null
  const sides = [entry.oldMode, entry.newMode]
  if (sides.includes(MODES.link)) return { tier: 'deep', mode: 'a symbolic link' }
  if (sides.includes(MODES.submodule)) return { tier: 'deep', mode: 'a submodule' }
  if (entry.newMode === MODES.executable) return { tier: 'light', mode: 'an executable file' }
  return null
}

/**
 * One file's tier: { path, tier, rules }, and `tests` when it took the tier of the file it tests (a test
 * of a deep file guards that boundary, so weakening it is deep too), `commentsOnly` (the tier its name
 * gives) when only its comments changed and that put it lower, or `mode` when its mode put it higher
 * (`entry`: its modes before and after, from `changedEntries`; none for a bare path).
 */
export function tierOfFile(path, rules, entry = null, commentsOnly = false) {
  const p = String(path).split('\\').join('/').replace(/^\.\//, '')
  let best = { path: p, ...ownTier(p, rules) }
  for (const s of subjectsOf(p)) {
    const t = ownTier(s, rules)
    if (rank(t.tier) > rank(best.tier)) best = { path: p, ...t, tests: s }
  }
  if (commentsOnly && rank(best.tier) > rank(COMMENT_ONLY_TIER)) best = { path: p, tier: COMMENT_ONLY_TIER, rules: [], commentsOnly: best.tier }
  const m = modeTier(entry)
  if (m && rank(m.tier) > rank(best.tier)) best = { path: p, tier: m.tier, rules: [], mode: m.mode }
  return best
}

/**
 * A change's tier: { tier, files, because, counts }. `because` is the files at that tier, the ones that
 * put it there; `counts` how many files fell in each tier. No files at all is auto: nothing to review.
 * `modes`: each path's modes (`changedEntries`), when they are known; `commentsOnly`: the paths whose change
 * is only in comments, spaces and blank lines (`commentsOnly`), when their contents were read.
 */
export function classify(paths, rules, modes = new Map(), commentsOnly = new Set()) {
  const files = [...new Set(paths)].map((p) => tierOfFile(p, rules, modes.get(p) ?? null, commentsOnly.has(p)))
  const tier = files.map((f) => f.tier).reduce(higher, 'auto')
  const counts = Object.fromEntries(TIERS.map((t) => [t, files.filter((f) => f.tier === t).length]).filter(([, n]) => n))
  return { tier, files, because: files.filter((f) => f.tier === tier), counts }
}

/** Why a file has its tier, in a few words: its rules, or that none matched. */
export function reasonOf(file, rules) {
  if (file.mode) return file.mode
  if (file.commentsOnly) return `only comments changed, else ${file.commentsOnly}`
  if (!file.rules.length) return `no rule matches: ${rules.fallback}`
  return `${file.rules.join(', ')}${file.tests ? `, as the test of ${file.tests}` : ''}`
}

/**
 * The answer when there is nothing to judge by (no rules, rules that cannot be read, a failure): deep,
 * so a missing or broken rule never lets a change through unreviewed.
 */
export function unjudged(why) {
  return { tier: 'deep', files: [], because: [], counts: {}, rulesFrom: null, unjudged: why, line: `Tier: deep (${why}).`, text: `tier: deep\n${why}, so it is deep.` }
}

/** The one line for a pull request's Verified: "Tier: deep (rules; path: rule, …)". At most `max` files are named. */
export function tierLine(result, rules, max = 4) {
  if (!result.files.length) return 'Tier: auto (no files changed).'
  const named = result.because.slice(0, max).map((f) => `\`${f.path}\` (${reasonOf(f, rules)})`)
  const more = result.because.length - named.length
  const others = Object.entries(result.counts)
    .filter(([t]) => t !== result.tier)
    .map(([t, n]) => `${n} ${t}`)
  return `Tier: ${result.tier}, from ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}${others.length ? `; the other files: ${others.join(', ')}` : ''}.`
}

/** The text `pnpm tier` prints: the tier, then each file that put it there with its rules' why. */
export function report(result, rules) {
  const byId = new Map(rules.rules.map((r) => [r.id, r]))
  const lines = [`tier: ${result.tier}`]
  if (!result.files.length) return [...lines, 'No files changed.'].join('\n')
  lines.push(`${result.because.length} file(s) put it there:`)
  for (const f of result.because) {
    lines.push(`  ${f.path}${f.tests ? ` (a test of ${f.tests}, which takes its tier)` : ''}`)
    if (f.mode) lines.push(`      ${f.mode}, so ${f.tier} whatever its name says`)
    else if (f.commentsOnly) lines.push(`      only its comments, spaces and blank lines changed, so at most ${COMMENT_ONLY_TIER} (by its name: ${f.commentsOnly})`)
    else if (!f.rules.length) lines.push(`      no rule matches it, so ${rules.fallback} (${RULES_FILE} "fallback")`)
    for (const id of f.rules) lines.push(`      ${id}: ${byId.get(id).why}`)
  }
  const others = Object.entries(result.counts).filter(([t]) => t !== result.tier)
  if (others.length) lines.push(`The other files: ${others.map(([t, n]) => `${n} ${t}`).join(', ')}.`)
  return lines.join('\n')
}

/**
 * A pull request's tier from its labels: the highest tier:<name>. None (opened without pre-pr, or the
 * label lost) is deep: an unknown tier is never taken as a lower one. The merge queue's hook.
 */
export function tierOfLabels(labels) {
  const tiers = (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((l) => typeof l === 'string' && l.startsWith(LABEL_PREFIX)).map((l) => l.slice(LABEL_PREFIX.length)).filter((t) => TIERS.includes(t))
  return tiers.length ? tiers.reduce(higher) : 'deep'
}

// --- Comment-only changes (#2352) --------------------------------------------------------------

/**
 * The most a file whose change is only in comments, spaces and blank lines takes: a comment fix in a deep file does not
 * make the change deep, and it is still reviewed, since a deleted comment may be one that mattered and a wrong judgment
 * here must not land code unreviewed.
 */
export const COMMENT_ONLY_TIER = 'light'

/** The files judged by their comments, by extension, as TypeScript's ScriptKind names them; any other keeps its name's tier */
const SCRIPT_KINDS = { ts: 'TS', mts: 'TS', cts: 'TS', tsx: 'TSX', js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JSX' }
const scriptKindOf = (path) => SCRIPT_KINDS[/\.([^./]+)$/.exec(path)?.[1].toLowerCase() ?? '']
const LINE_BREAK = /[\n\r\u2028\u2029]/

/**
 * Comments a tool reads, so changing one changes what runs or what is checked: TypeScript's and ESLint's directives
 * (`@ts-expect-error`, `eslint-disable`, `/* global x *\/`), Prettier's ignore, bundler and coverage hints
 * (`@vite-ignore`, `__PURE__`, `webpackChunkName`, `c8 ignore`), pragmas (`@jsx`, `@vitest-environment`, `@refresh`),
 * a triple-slash reference, a source map. Broad on purpose: a prose comment it takes for one keeps its tier.
 */
const TOOL_COMMENT = /@ts-|@jsx|@vite|@vitest|@refresh|@deprecated|@license|@preserve|[@#]__\w+__|eslint|prettier|\b(?:c8|v8|istanbul|biome|oxlint|dprint)\b|webpack[A-Z]|sourceMappingURL|sourceURL|^\/\*\s*(?:globals?|exported)\s|^\/\/\/\s*</

/**
 * A file as what changing it can change: its tokens in order (from the parsed tree, so a regular expression or a
 * template is one token), each with whether a line break comes before it (automatic semicolons), the comments a tool
 * reads with all that follows them up to their token, and the `#!` line. In JavaScript every comment with an `@tag`
 * counts too: JSDoc there is types. Null when it cannot be told that the file parsed cleanly: then it is not judged.
 */
function scriptShape(ts, path, text) {
  const kind = scriptKindOf(path)
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, ts.ScriptKind[kind])
  const js = kind.startsWith('JS')
  // TypeScript reads no HTML-like comment, which a classic script does: `a < !--b` and `a <!--b` would look alike
  if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length || (js && /<!--|-->/.test(text))) return null
  const shape = [/^#![^\n]*/.exec(text)?.[0] ?? '']
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    // a token is a leaf, also the end of the file, whose children are the JSDoc before it
    const children = node.kind <= ts.SyntaxKind.LastToken ? [] : node.getChildren(sf)
    if (children.length || node.kind === ts.SyntaxKind.SyntaxList) return children.forEach(visit)
    // JSX text starts at its full start: what looks like a comment in it is text on screen
    const start = node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sf)
    const between = text.slice(node.pos, start)
    // the comments between the token before and this one: the ones on its line (TypeScript's "trailing"), then the rest
    const comments = [...(ts.getTrailingCommentRanges(text, node.pos) ?? []), ...(ts.getLeadingCommentRanges(text, node.pos) ?? [])]
    const read = comments.find((c) => TOOL_COMMENT.test(text.slice(c.pos, c.end)) || (js && /@[a-z]/i.test(text.slice(c.pos, c.end))))
    // from a comment a tool reads on, all of it counts: what stands between a directive and its line decides what it covers
    if (read) shape.push(text.slice(read.pos, start))
    shape.push(node.pos > 0 && LINE_BREAK.test(between) ? '\n' : ' ', node.kind, text.slice(start, node.end))
  }
  visit(sf)
  return shape
}

/**
 * The typescript package as the checkout at `root` installs it, or null when it is not there or has no JavaScript API
 * (typescript 7): then nothing is judged comment-only. From the checkout only: the integrator runs a copy of this file
 * from a temporary folder, above which another typescript may sit.
 */
function typescriptAt(root) {
  try {
    const ts = createRequire(join(root, 'package.json'))('typescript')
    return typeof ts?.createSourceFile === 'function' ? ts : null
  } catch {
    return null
  }
}

/**
 * Whether going from `before` to `after` changes only comments, spaces and blank lines in the TypeScript or JavaScript
 * file `path` (`ts`: the typescript package). A line break added or removed between two tokens, a comment a tool reads,
 * any other kind of file, or a file that does not parse: false.
 */
export function commentsOnly(path, before, after, ts) {
  if (before === after || !ts || !scriptKindOf(path)) return false
  const a = scriptShape(ts, path, before)
  const b = scriptShape(ts, path, after)
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)
}

// --- Reading a checkout -------------------------------------------------------------------------

// git started here, not through scripts/interrupts.mjs: the board runs main's copy of this file alone (queue-integrate.mjs)
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** The rules as `ref` has them, else as `fallbackRef` has them: { rules, from }, or null when neither has the file. */
export function rulesAt(root, ref, fallbackRef) {
  // A ref that is not there is an error, not "no rules": falling back to the head's rules would let a change judge itself
  for (const r of [ref, fallbackRef].filter(Boolean)) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])
    } catch {
      throw new Error(`${r} is not a commit here.`)
    }
  }
  for (const r of [ref, fallbackRef].filter(Boolean)) {
    let text
    try {
      text = git(root, ['show', `${r}:${RULES_FILE}`])
    } catch {
      continue
    }
    return { rules: parseRules(text, `${RULES_FILE} at ${r}`), from: r }
  }
  return null
}

/**
 * What `head` changes over where it left `base`, with modes: { path, oldMode, newMode, oldSha, newSha } per file (added,
 * changed and deleted, renames as both names; 000000 is "not there"). From `git diff --raw -z`, whose
 * records are ":<old mode> <new mode> <old sha> <new sha> <status>" and then the path, each ended by a NUL.
 */
export function changedEntries(root, base, head) {
  const fork = git(root, ['merge-base', base, head]).trim()
  // --ignore-submodules=none: a .gitmodules "ignore = all" or a diff.ignoreSubmodules setting must not hide a submodule
  const parts = git(root, ['diff', '--raw', '--no-renames', '--no-abbrev', '--ignore-submodules=none', '-z', fork, head]).split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith(':')) continue
    const [oldMode, newMode, oldSha, newSha] = parts[i].slice(1).split(' ')
    out.push({ path: parts[i + 1], oldMode, newMode, oldSha, newSha })
    i += 1
  }
  return out
}

/** The files `head` changes over where it left `base`: added, changed and deleted, renames as both names. */
export function changedFiles(root, base, head) {
  return changedEntries(root, base, head).map((e) => e.path)
}

const PLAIN_FILES = [MODES.executable, '100644']

/**
 * The paths among `entries` (`changedEntries`) whose change is only comments: a TypeScript or JavaScript file, plain on
 * both sides, whose name puts it above COMMENT_ONLY_TIER and above every file that cannot be judged, read from git by its
 * blobs. No other is read: judging it would not lower the change.
 */
function commentOnlyPaths(root, entries, rules) {
  const judgeable = (e) => scriptKindOf(e.path) && PLAIN_FILES.includes(e.oldMode) && PLAIN_FILES.includes(e.newMode)
  // a file whose tier another file reaches anyway would not lower the change
  const floor = entries.filter((e) => !judgeable(e)).map((e) => tierOfFile(e.path, rules, e).tier).reduce(higher, COMMENT_ONLY_TIER)
  const judged = entries.filter((e) => judgeable(e) && rank(tierOfFile(e.path, rules).tier) > rank(floor))
  // loaded only when a file is judged: it takes longer than the rest of a run
  const ts = judged.length ? typescriptAt(root) : null
  if (!ts) return new Set()
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  // as text only when it is UTF-8: two bytes that both decode to U+FFFD would look alike. A git that fails, an
  // interrupted one too, throws: tierOfChange's callers answer that as deep, or stop on the interrupt
  const text = (sha) => {
    const bytes = execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    try {
      return utf8.decode(bytes)
    } catch {
      return null
    }
  }
  return new Set(
    judged
      .filter((e) => {
        const [before, after] = [text(e.oldSha), text(e.newSha)]
        return before !== null && after !== null && commentsOnly(e.path, before, after, ts)
      })
      .map((e) => e.path),
  )
}

/**
 * The tier of what `head` adds over `base`, judged by the rules at `rulesRef` (base by default; the
 * head's when that has none). Deep (`unjudged`) when neither has a rules file; throws when a ref is
 * not there or the rules cannot be read, which callers answer as deep too.
 */
export function tierOfChange({ root, base, head, rulesRef = base }) {
  const found = rulesAt(root, rulesRef, head)
  if (!found) return unjudged(`no ${RULES_FILE} at ${rulesRef} or ${head}`)
  const entries = changedEntries(root, base, head)
  const result = classify(
    entries.map((e) => e.path),
    found.rules,
    new Map(entries.map((e) => [e.path, e])),
    commentOnlyPaths(root, entries, found.rules),
  )
  return { ...result, rulesFrom: found.from, line: tierLine(result, found.rules), text: report(result, found.rules) }
}

export function parseArgs(argv) {
  const o = { base: 'origin/main', head: 'HEAD', json: false, paths: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      o.paths = argv.slice(i + 1)
      break
    }
    if (a === '--json') o.json = true
    else if (a === '--base' || a === '--head') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a ref.`)
      o[a.slice(2)] = argv[++i]
    } else throw new Error(`Unknown argument ${a}. Usage: pnpm tier [--base <ref>] [--head <ref>] [--json] [-- <path>...]`)
  }
  return o
}

function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`tier: ${e.message}`)
    process.exitCode = 2
    return
  }
  // Anything that keeps the change from being judged answers deep, with why (and exit 2)
  let r
  try {
    const root = resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
    if (o.paths) {
      const rules = parseRules(readFileSync(join(root, RULES_FILE), 'utf8'))
      const result = classify(o.paths, rules)
      r = { ...result, rulesFrom: 'the working tree', line: tierLine(result, rules), text: report(result, rules) }
    } else r = tierOfChange({ root, base: o.base, head: o.head })
  } catch (e) {
    r = unjudged(`the change could not be judged: ${String(e.message).trim()}`)
    process.exitCode = 2
  }
  if (o.json) process.stdout.write(`${JSON.stringify({ tier: r.tier, line: r.line, because: r.because, counts: r.counts, rulesFrom: r.rulesFrom, ...(r.unjudged ? { unjudged: r.unjudged } : {}) })}\n`)
  else console.log(r.rulesFrom ? `${r.text}\n(rules: ${RULES_FILE} from ${r.rulesFrom})` : r.text)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
