// A change's risk tier, by the paths it touches (#1259 step 2): `pnpm tier`.
//
// The rules are .centralu/tiers.json. Each file takes the highest tier of the rules that match it
// (light when none does), and the change takes the highest tier of its files:
//
//   auto    lands after the fast gate with no review (docs, tests, styles).
//   light   one review by another model inside the author's session before it says done.
//   deep    a separate review session that runs real-environment cases.
//   person  the owner decides; never given by path, only by the label tier:person set by hand.
//
// What says why: the files at the change's tier, each with the rules that put it there.
//
//   node scripts/tier.mjs [--base <ref>] [--head <ref>] [--json]      the commits from base to head
//   node scripts/tier.mjs [--json] -- <path>...                        the paths given
//
// --base defaults to origin/main, --head to HEAD; the change is what head adds over where it left
// base. The rules are read from base, so a change cannot loosen the rules that judge it; a base
// without them (before they existed) leaves the head's. pre-pr.mjs puts the tier in its answer, and the
// board's open_pr writes it into Verified and labels the pull request tier:<name>.
//
// The merge queue's hook: the tier of what it lands is the higher of `tierOfChange` at that head
// and `tierOfLabels(labels)` (the highest tier:<name> label: open_pr's, from when it opened, or a
// person's, raised by hand). The label alone goes stale when commits are pushed after it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULES_FILE = '.centralu/tiers.json'
export const TIERS = ['auto', 'light', 'deep', 'person']
export const LABEL_PREFIX = 'tier:'

// --- Rules --------------------------------------------------------------------------------------

/** A glob as a regular expression over a whole path: `**` any number of folders, `*` and `?` within one name, `{a,b}` either. */
export function globToRegExp(glob) {
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
  return new RegExp(`^${re}$`)
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
    const globs = (list, key) => {
      if (list === undefined && key === 'except') return []
      if (!Array.isArray(list) || (key === 'paths' && !list.length) || list.some((g) => typeof g !== 'string' || !g)) fail(`${at}: ${key} must be a list of globs.`)
      return list.map((g) => {
        try {
          return globToRegExp(g)
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

/** One file's tier: { path, tier, rules } with the ids of the rules that gave it (none: the fallback). */
export function tierOfFile(path, rules) {
  const p = String(path).split('\\').join('/').replace(/^\.\//, '')
  const hits = rules.rules.filter((r) => r.paths.some((re) => re.test(p)) && !r.except.some((re) => re.test(p)))
  if (!hits.length) return { path: p, tier: rules.fallback, rules: [] }
  const tier = hits.map((r) => r.tier).reduce(higher)
  return { path: p, tier, rules: hits.filter((r) => r.tier === tier).map((r) => r.id) }
}

/**
 * A change's tier: { tier, files, because, counts }. `because` is the files at that tier, the ones that
 * put it there; `counts` how many files fell in each tier. No files at all is auto: nothing to review.
 */
export function classify(paths, rules) {
  const files = [...new Set(paths)].map((p) => tierOfFile(p, rules))
  const tier = files.map((f) => f.tier).reduce(higher, 'auto')
  const counts = Object.fromEntries(TIERS.map((t) => [t, files.filter((f) => f.tier === t).length]).filter(([, n]) => n))
  return { tier, files, because: files.filter((f) => f.tier === tier), counts }
}

/** Why a file has its tier, in a few words: its rules, or that none matched. */
export function reasonOf(file, rules) {
  if (!file.rules.length) return `no rule matches: ${rules.fallback}`
  return file.rules.join(', ')
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
    lines.push(`  ${f.path}`)
    if (!f.rules.length) lines.push(`      no rule matches it, so ${rules.fallback} (${RULES_FILE} "fallback")`)
    for (const id of f.rules) lines.push(`      ${id}: ${byId.get(id).why}`)
  }
  const others = Object.entries(result.counts).filter(([t]) => t !== result.tier)
  if (others.length) lines.push(`The other files: ${others.map(([t, n]) => `${n} ${t}`).join(', ')}.`)
  return lines.join('\n')
}

/** A pull request's tier from its labels: the highest tier:<name>, or null when it has none. The merge queue's hook. */
export function tierOfLabels(labels) {
  const tiers = (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((l) => typeof l === 'string' && l.startsWith(LABEL_PREFIX)).map((l) => l.slice(LABEL_PREFIX.length)).filter((t) => TIERS.includes(t))
  return tiers.length ? tiers.reduce(higher) : null
}

// --- Reading a checkout -------------------------------------------------------------------------

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

/** The files `head` changes over where it left `base`: added, changed and deleted, renames as both names. */
export function changedFiles(root, base, head) {
  const fork = git(root, ['merge-base', base, head]).trim()
  return git(root, ['diff', '--name-only', '--no-renames', '-z', fork, head]).split('\0').filter(Boolean)
}

/**
 * The tier of what `head` adds over `base`, judged by the rules at `rulesRef` (base by default; the
 * head's when that has none). null when neither has a rules file.
 */
export function tierOfChange({ root, base, head, rulesRef = base }) {
  const found = rulesAt(root, rulesRef, head)
  if (!found) return null
  const result = classify(changedFiles(root, base, head), found.rules)
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
    const root = resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
    let r
    if (o.paths) {
      const rules = parseRules(readFileSync(join(root, RULES_FILE), 'utf8'))
      const result = classify(o.paths, rules)
      r = { ...result, rulesFrom: 'the working tree', line: tierLine(result, rules), text: report(result, rules) }
    } else {
      r = tierOfChange({ root, base: o.base, head: o.head })
      if (!r) throw new Error(`${RULES_FILE} is at neither ${o.base} nor ${o.head}.`)
    }
    if (o.json) process.stdout.write(`${JSON.stringify({ tier: r.tier, line: r.line, because: r.because, counts: r.counts, rulesFrom: r.rulesFrom })}\n`)
    else console.log(`${r.text}\n(rules: ${RULES_FILE} from ${r.rulesFrom})`)
  } catch (e) {
    if (o?.json) process.stdout.write(`${JSON.stringify({ error: e.message })}\n`)
    else console.error(`tier: ${e.message}`)
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
